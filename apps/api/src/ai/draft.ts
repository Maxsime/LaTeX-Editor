import { type ProposedEdit, ToolError } from '@galley/ai';
import type { AiHunk } from '@galley/shared';
import { diffLines } from 'diff';
import type { ProjectText } from '../materialize.js';
import {
  buildHunks,
  CONTEXT_CHARS,
  citationViolations,
  type FetchedEntry,
  knownCitationKeys,
} from './changes.js';

/** Provisional id of a file the draft creates, until the user accepts it. */
const NEW_FILE_PREFIX = 'draft:';

/** Applies located hunks to a text, last first so that earlier offsets stay valid. */
function applyHunks(text: string, hunks: readonly AiHunk[]): string {
  let result = text;
  for (const hunk of [...hunks].sort((left, right) => right.start - left.start)) {
    result =
      result.slice(0, hunk.start) +
      hunk.replacement +
      result.slice(hunk.start + hunk.original.length);
  }
  return result;
}

/**
 * Hunks turning `before` into `after`, one per run of changed lines, located
 * in `before` with the context the server needs to find them again.
 */
export function diffHunks(
  file: { fileId: string; path: string },
  before: string,
  after: string,
  firstId: number,
): AiHunk[] {
  const hunks: AiHunk[] = [];
  let offset = 0;
  let open: { start: number; original: string; replacement: string } | null = null;
  const close = () => {
    if (open === null) return;
    const end = open.start + open.original.length;
    hunks.push({
      id: `h${String(firstId + hunks.length)}`,
      fileId: file.fileId,
      path: file.path,
      ...open,
      before: before.slice(Math.max(0, open.start - CONTEXT_CHARS), open.start),
      after: before.slice(end, end + CONTEXT_CHARS),
    });
    open = null;
  };
  for (const change of diffLines(before, after)) {
    if (!change.added && !change.removed) {
      close();
      offset += change.value.length;
      continue;
    }
    open ??= { start: offset, original: '', replacement: '' };
    if (change.removed) {
      open.original += change.value;
      offset += change.value.length;
    } else {
      open.replacement += change.value;
    }
  }
  close();
  return hunks;
}

/**
 * The private copy of a project the agent works on during one request
 * (SPEC §3.8): the project's texts, overlaid with the files it edited or
 * created. Nothing reaches the project until the user accepts the changeset
 * built by {@link Draft.hunks}.
 */
export class Draft {
  private readonly base: ReadonlyMap<string, ProjectText>;
  private readonly current = new Map<string, ProjectText>();
  /** Whether the draft was proposed to the user; it may be only once. */
  submitted = false;

  constructor(texts: readonly ProjectText[]) {
    this.base = new Map(texts.map((file) => [file.path, file]));
  }

  /** The texts as the agent sees them, its edits included. */
  texts(): ProjectText[] {
    const merged = new Map(this.base);
    for (const [path, file] of this.current) merged.set(path, file);
    return [...merged.values()];
  }

  /** The original texts of the project. */
  original(): ProjectText[] {
    return [...this.base.values()];
  }

  /** Paths whose text differs from the project's, created files included. */
  changedPaths(): string[] {
    return [...this.current.values()]
      .filter((file) => this.base.get(file.path)?.text !== file.text)
      .map((file) => file.path);
  }

  /**
   * Applies `edits` to the draft, with the checks of a proposal: located
   * search texts, valid new paths, sizes and citations. All edits apply or
   * none does. Returns the paths changed.
   */
  edit(
    edits: readonly ProposedEdit[],
    folders: ReadonlySet<string>,
    binaries: ReadonlySet<string>,
    fetched: readonly FetchedEntry[],
  ): string[] {
    if (this.submitted) {
      throw new ToolError('The draft was already submitted: it cannot change any more.');
    }
    const texts = this.texts();
    const hunks = buildHunks(texts, folders, binaries, edits);
    const violations = citationViolations(hunks, knownCitationKeys(texts, fetched), fetched);
    if (violations.length > 0) throw new ToolError(violations.join('\n'));
    const byPath = new Map(texts.map((file) => [file.path, file]));
    const paths = [...new Set(hunks.map((hunk) => hunk.path))];
    for (const path of paths) {
      const own = hunks.filter((hunk) => hunk.path === path);
      const file = byPath.get(path);
      this.current.set(
        path,
        file === undefined
          ? {
              id: `${NEW_FILE_PREFIX}${path}`,
              path,
              text: own.map((hunk) => hunk.replacement).join(''),
            }
          : { ...file, text: applyHunks(file.text, own) },
      );
    }
    return paths;
  }

  /** The changes of the draft against the project, as the hunks of one changeset. */
  hunks(): AiHunk[] {
    const hunks: AiHunk[] = [];
    for (const path of this.changedPaths()) {
      const draft = this.current.get(path);
      if (draft === undefined) continue;
      const original = this.base.get(path);
      if (original === undefined) {
        hunks.push({
          id: `h${String(hunks.length + 1)}`,
          fileId: null,
          path,
          start: 0,
          original: '',
          replacement: draft.text,
          before: '',
          after: '',
        });
      } else {
        hunks.push(
          ...diffHunks({ fileId: original.id, path }, original.text, draft.text, hunks.length + 1),
        );
      }
    }
    return hunks;
  }
}
