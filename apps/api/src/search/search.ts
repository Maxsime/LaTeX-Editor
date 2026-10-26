import { LineIndex } from '@galley/latex-index';
import { ApiError, MAX_SEARCH_RESULTS, type SearchMatch } from '@galley/shared';
import { RE2JS } from 're2js';

export interface SearchOptions {
  q: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** A text file as read for searching. */
export interface SearchableFile {
  id: string;
  path: string;
  text: string;
}

/** Characters kept on each side of a match in its preview. */
const PREVIEW_CONTEXT = 80;

/**
 * Compiles a user query. Patterns run on RE2 semantics (linear time, no
 * backreferences), so a hostile expression cannot stall the server.
 *
 * @throws {ApiError} INVALID_PATTERN when the expression does not compile.
 */
export function compileQuery({ q, regex, caseSensitive, wholeWord }: SearchOptions): RE2JS {
  let source = regex ? q : RE2JS.quote(q);
  if (wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return RE2JS.compile(source, caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE);
  } catch {
    throw new ApiError('INVALID_PATTERN');
  }
}

function preview(text: string, start: number, end: number): { preview: string; offset: number } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', start);
  const lineEnd = newline === -1 ? text.length : newline;
  const from = Math.max(lineStart, start - PREVIEW_CONTEXT);
  const to = Math.min(lineEnd, Math.max(end, start) + PREVIEW_CONTEXT);
  return { preview: text.slice(from, to), offset: start - from };
}

/** Finds matches across files, in path order, up to {@link MAX_SEARCH_RESULTS}. */
export function searchFiles(
  files: readonly SearchableFile[],
  options: SearchOptions,
): { matches: SearchMatch[]; truncated: boolean } {
  const pattern = compileQuery(options);
  const matches: SearchMatch[] = [];
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const matcher = pattern.matcher(file.text);
    let lines: LineIndex | null = null;
    while (matcher.find()) {
      const start = matcher.start();
      const end = matcher.end();
      // An empty match (e.g. `^`) carries no information and would flood the results.
      if (end === start) continue;
      if (matches.length === MAX_SEARCH_RESULTS) return { matches, truncated: true };
      lines ??= new LineIndex(file.text);
      const line = lines.lineOf(start);
      const lineStart = file.text.lastIndexOf('\n', start - 1) + 1;
      const shown = preview(file.text, start, end);
      matches.push({
        fileId: file.id,
        path: file.path,
        line,
        column: start - lineStart,
        length: end - start,
        preview: shown.preview,
        previewOffset: shown.offset,
      });
    }
  }
  return { matches, truncated: false };
}

/** Expands `$&`, `$1`…`$99` and `$$` in a replacement template, as JavaScript does. */
export function expandTemplate(template: string, groups: readonly (string | undefined)[]): string {
  return template.replace(/\$(\$|&|\d{1,2})/g, (whole, token: string) => {
    if (token === '$') return '$';
    if (token === '&') return groups[0] ?? '';
    const index = Number(token);
    if (index < groups.length) return groups[index] ?? '';
    // "$12" with one group reads as group 1 followed by "2".
    const single = Number(token[0]);
    if (token.length === 2 && single < groups.length)
      return (groups[single] ?? '') + token.slice(1);
    return whole;
  });
}

/**
 * Applies a replacement to one text. In literal mode the replacement is
 * inserted as is; with a regular expression, `$1` names a capture group.
 * Empty matches are left alone: replacing them would insert text everywhere.
 */
export function replaceInText(
  text: string,
  pattern: RE2JS,
  replacement: string,
  regex: boolean,
): { text: string; count: number } {
  const groupCount = pattern.groupCount();
  let count = 0;
  const replaced = pattern.matcher(text).replaceAll((...args: unknown[]) => {
    // Replacer arguments follow String.prototype.replace: match, groups…, offset, input.
    const groups = args
      .slice(0, groupCount + 1)
      .map((value) => (typeof value === 'string' ? value : undefined));
    const match = groups[0] ?? '';
    if (match === '') return '';
    count += 1;
    return regex ? expandTemplate(replacement, groups) : replacement;
  });
  return { text: count === 0 ? text : replaced, count };
}
