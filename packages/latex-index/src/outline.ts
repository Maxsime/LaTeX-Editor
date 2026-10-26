import { extractStructure, HEADING_DEPTH, type HeadingLevel, type Structure } from './structure.js';

export interface OutlineEntry {
  /** Project-relative path of the file holding the heading. */
  path: string;
  line: number;
  level: HeadingLevel;
  depth: number;
  title: string;
  starred: boolean;
}

/** Directory part of a project path, `''` at the root. */
export function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * Joins a reference to a base directory and normalises it. References that
 * climb out of the project or are absolute resolve to `null`.
 */
export function joinPath(base: string, reference: string): string | null {
  if (reference.startsWith('/') || /^[a-zA-Z]:/.test(reference)) return null;
  const parts: string[] = base === '' ? [] : base.split('/');
  for (const part of reference.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/**
 * Finds the project file a LaTeX reference points to, trying the reference as
 * written, then with each default extension, as TeX does for `\input`.
 */
export function resolveReference(
  exists: (path: string) => boolean,
  base: string,
  reference: string,
  extensions: readonly string[] = ['.tex'],
): string | null {
  const joined = joinPath(base, reference.replace(/^"|"$/g, ''));
  if (joined === null || joined === '') return null;
  if (exists(joined)) return joined;
  for (const extension of extensions) {
    if (exists(joined + extension)) return joined + extension;
  }
  return null;
}

/** Inclusion depth past which the outline stops following files. */
const MAX_DEPTH = 32;

/**
 * Builds the outline of a document from its main file, following `\input`,
 * `\include`, `\subfile` and `\import` in document order. Each file is
 * expanded once, so cycles and repeated inclusions do not loop.
 *
 * @param files - text content by project-relative path.
 * @param structureOf - structure of a file, so callers can cache extraction.
 */
export function buildOutline(
  files: ReadonlyMap<string, string>,
  mainPath: string,
  structureOf: (path: string, text: string) => Structure = (_path, text) => extractStructure(text),
): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const expanded = new Set<string>();
  // TeX resolves \input against its working directory, the main file's folder.
  const root = dirname(mainPath);
  const exists = (path: string): boolean => files.has(path);

  function visit(path: string, depth: number): void {
    const text = files.get(path);
    if (text === undefined || expanded.has(path) || depth > MAX_DEPTH) return;
    expanded.add(path);
    const structure = structureOf(path, text);
    const events = [
      ...structure.headings.map((heading) => ({ offset: heading.offset, heading })),
      ...structure.includes.map((include) => ({ offset: include.offset, include })),
    ].sort((left, right) => left.offset - right.offset);

    for (const event of events) {
      if ('heading' in event) {
        const { heading } = event;
        entries.push({
          path,
          line: heading.line,
          level: heading.level,
          depth: HEADING_DEPTH[heading.level],
          title: heading.title,
          starred: heading.starred,
        });
        continue;
      }
      const { include } = event;
      let target: string | null = null;
      if (include.kind === 'input' || include.kind === 'include') {
        target = resolveReference(exists, root, include.path);
      } else if (include.kind === 'subfile') {
        target = resolveReference(exists, dirname(path), include.path);
      } else if (include.kind === 'import') {
        const directory = joinPath(dirname(path), include.directory ?? '');
        target = directory === null ? null : resolveReference(exists, directory, include.path);
      }
      if (target !== null) visit(target, depth + 1);
    }
  }

  visit(mainPath, 0);
  return entries;
}
