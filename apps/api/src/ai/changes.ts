import { type ProposedEdit, ToolError } from '@galley/ai';
import { checkBibtex, extractKeyUses, extractStructure } from '@galley/latex-index';
import { type AiHunk, MAX_TEXT_BYTES, splitProjectPath } from '@galley/shared';
import type { ProjectText } from '../materialize.js';

/** Characters of context kept on each side of a hunk, to find it again later. */
const CONTEXT_CHARS = 40;

/** Extensions a proposal may create: sources, never binaries. */
const CREATABLE = /\.(tex|bib|sty|cls|bst|bbx|cbx|dtx|ins|txt|md|cfg|def|lua|tikz)$/i;

function isBib(path: string): boolean {
  return path.toLowerCase().endsWith('.bib');
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
    found.push(index);
  }
  return found;
}

/** Strips a leading `./` and repeated slashes, which models sometimes add. */
function normalisePath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\/+/g, '/');
}

/**
 * Turns the edits of `propose_changes` into hunks located in the current
 * texts. Refusals are {@link ToolError}s worded for the model to correct.
 *
 * - `search` must occur exactly once in the file;
 * - an empty `search` appends to an existing file, or creates a new text file;
 * - two edits of one file may not overlap.
 */
export function buildHunks(
  texts: readonly ProjectText[],
  folders: ReadonlySet<string>,
  binaries: ReadonlySet<string>,
  edits: readonly ProposedEdit[],
): AiHunk[] {
  const byPath = new Map(texts.map((file) => [file.path, file]));
  const hunks: AiHunk[] = [];
  const created = new Map<string, number>();
  for (const [index, edit] of edits.entries()) {
    const path = normalisePath(edit.path);
    const id = `h${String(index + 1)}`;
    const file = byPath.get(path);
    if (file === undefined) {
      if (binaries.has(path)) throw new ToolError(`${path} is a binary file and cannot be edited.`);
      if (folders.has(path)) throw new ToolError(`${path} is a folder.`);
      if (edit.search !== '') {
        throw new ToolError(
          `No text file ${path} in the project. Use list_files to see the paths, or an empty search to create a new file.`,
        );
      }
      if (splitProjectPath(path) === null || !CREATABLE.test(path)) {
        throw new ToolError(`${path} is not a valid path for a new source file.`);
      }
      if (created.has(path)) throw new ToolError(`${path} is created twice.`);
      created.set(path, hunks.length);
      hunks.push({
        id,
        fileId: null,
        path,
        start: 0,
        original: '',
        replacement: edit.replace,
        before: '',
        after: '',
      });
      continue;
    }
    let start: number;
    if (edit.search === '') {
      start = file.text.length;
    } else {
      const found = occurrences(file.text, edit.search);
      if (found.length === 0) {
        throw new ToolError(
          `The search text of edit ${String(index + 1)} was not found in ${path}. Copy it exactly from the file (read_file).`,
        );
      }
      if (found.length > 1) {
        throw new ToolError(
          `The search text of edit ${String(index + 1)} occurs ${String(found.length)} times in ${path}. Include more surrounding text so that it occurs once.`,
        );
      }
      start = found[0] ?? 0;
    }
    // Appending: separate from the previous content by a newline.
    const replacement =
      edit.search === '' && file.text !== '' && !file.text.endsWith('\n')
        ? `\n${edit.replace}`
        : edit.replace;
    const end = start + edit.search.length;
    const overlapping = hunks.find(
      (hunk) =>
        hunk.fileId === file.id &&
        start < hunk.start + hunk.original.length + (hunk.original === '' ? 1 : 0) &&
        hunk.start < end + (edit.search === '' ? 1 : 0),
    );
    if (overlapping !== undefined) {
      throw new ToolError(
        `Edits ${overlapping.id.slice(1)} and ${String(index + 1)} of ${path} overlap.`,
      );
    }
    hunks.push({
      id,
      fileId: file.id,
      path,
      start,
      original: edit.search,
      replacement,
      before: file.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
      after: file.text.slice(end, end + CONTEXT_CHARS),
    });
  }
  // A file must stay within the size the editor accepts.
  const growth = new Map<string, number>();
  for (const hunk of hunks) {
    const delta =
      Buffer.byteLength(hunk.replacement, 'utf8') - Buffer.byteLength(hunk.original, 'utf8');
    growth.set(hunk.path, (growth.get(hunk.path) ?? 0) + delta);
  }
  for (const [path, delta] of growth) {
    const current = Buffer.byteLength(byPath.get(path)?.text ?? '', 'utf8');
    if (current + delta > MAX_TEXT_BYTES) throw new ToolError(`${path} would become too large.`);
  }
  return hunks;
}

/** An entry fetched from a bibliographic service during the conversation. */
export interface FetchedEntry {
  key: string;
  bibtex: string;
}

function citedKeys(text: string): Set<string> {
  return new Set(
    extractKeyUses(text)
      .filter((use) => use.kind === 'citation')
      .map((use) => use.key),
  );
}

function normaliseEntry(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Keys a document may cite: entries of every `.bib`, `\bibitem`s, and the fetched entries. */
export function knownCitationKeys(
  texts: readonly ProjectText[],
  fetched: readonly FetchedEntry[],
): Set<string> {
  const known = new Set(fetched.map((entry) => entry.key));
  for (const file of texts) {
    if (isBib(file.path)) {
      for (const entry of checkBibtex(file.text).entries) known.add(entry.key);
    } else {
      for (const item of extractStructure(file.text).bibitems) known.add(item.name);
    }
  }
  return known;
}

/**
 * Checks the citations of proposed hunks (SPEC §6.8), on the server:
 * - a cited key must be known (see {@link knownCitationKeys}), unless the
 *   replaced text already cited it;
 * - an entry added to a `.bib` must be, up to whitespace, one fetched from a
 *   bibliographic service in the conversation: the model never writes one.
 *
 * @returns One message per violation, for the model and the logs; empty when all is well.
 */
export function citationViolations(
  hunks: readonly AiHunk[],
  known: ReadonlySet<string>,
  fetched: readonly FetchedEntry[],
): string[] {
  const violations: string[] = [];
  const verified = new Set(fetched.map((entry) => normaliseEntry(entry.bibtex)));
  for (const hunk of hunks) {
    if (isBib(hunk.path)) {
      const before = new Set(checkBibtex(hunk.original).entries.map((entry) => entry.key));
      for (const entry of checkBibtex(hunk.replacement).entries) {
        if (before.has(entry.key)) continue;
        const text = normaliseEntry(hunk.replacement.slice(entry.start, entry.end));
        if (!verified.has(text)) {
          violations.push(
            `The entry ${entry.key} added to ${hunk.path} was not obtained with fetch_bibtex. Bibliography entries must come from fetch_bibtex, unchanged.`,
          );
        }
      }
      continue;
    }
    const already = citedKeys(hunk.original);
    for (const key of citedKeys(hunk.replacement)) {
      if (!known.has(key) && !already.has(key)) {
        violations.push(
          `Unknown citation key ${key}: it is in no .bib file of the project. Use search_literature and fetch_bibtex to add a real reference, or remove the citation.`,
        );
      }
    }
  }
  return violations;
}
