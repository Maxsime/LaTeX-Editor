/**
 * Minimal LaTeX scanner: enough to find commands and their arguments while
 * ignoring comments, verbatim material and escaped characters. It does not
 * expand macros; a document that redefines `\section` is read literally.
 */

/** Environments whose content is not LaTeX and must not be scanned. */
const VERBATIM_ENVIRONMENTS = new Set([
  'verbatim',
  'verbatim*',
  'Verbatim',
  'Verbatim*',
  'BVerbatim',
  'LVerbatim',
  'lstlisting',
  'minted',
  'comment',
  'filecontents',
  'filecontents*',
]);

/** A control word met in the source, with the position just after its name. */
export interface CommandToken {
  name: string;
  /** Offset of the backslash. */
  start: number;
  /** Offset just after the name (and the star, if any). */
  end: number;
  starred: boolean;
}

/** A balanced group read after a command. */
export interface Group {
  content: string;
  /** Offset of the opening delimiter. */
  start: number;
  /** Offset just after the closing delimiter. */
  end: number;
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 64; // @ for package code
}

/** Offset of the next line start after `from`, or the text length. */
function endOfLine(text: string, from: number): number {
  const newline = text.indexOf('\n', from);
  return newline === -1 ? text.length : newline + 1;
}

/** Skips spaces, tabs and at most one line break, as TeX does between a command and its argument. */
export function skipSpaces(text: string, from: number): number {
  let position = from;
  let newlines = 0;
  for (;;) {
    const char = text[position];
    if (char === ' ' || char === '\t' || char === '\r') {
      position += 1;
    } else if (char === '\n' && newlines === 0) {
      newlines += 1;
      position += 1;
    } else if (char === '%') {
      // A comment ends the line without producing a space.
      position = endOfLine(text, position);
    } else {
      return position;
    }
  }
}

/**
 * Reads a group delimited by `open` and `close` starting at `from` (after
 * optional spaces). Nested braces are balanced; comments and escaped
 * delimiters are skipped.
 */
export function readGroup(text: string, from: number, open = '{', close = '}'): Group | null {
  const start = skipSpaces(text, from);
  if (text[start] !== open) return null;
  let depth = 0;
  // Square brackets do not nest in TeX, but braces inside them do protect a ].
  let braceDepth = 0;
  let position = start;
  while (position < text.length) {
    const char = text[position];
    if (char === '\\') {
      position += 2;
      continue;
    }
    if (char === '%') {
      position = endOfLine(text, position);
      continue;
    }
    if (open === '{') {
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return { content: text.slice(start + 1, position), start, end: position + 1 };
        }
      }
    } else if (char === '{') {
      braceDepth += 1;
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (char === open && position === start) {
      depth = 1;
    } else if (char === close && braceDepth === 0) {
      return { content: text.slice(start + 1, position), start, end: position + 1 };
    }
    position += 1;
  }
  return null;
}

/** Reads `[optional]` arguments, if any, then returns the position after them. */
export function skipOptionals(text: string, from: number): { end: number; optionals: string[] } {
  const optionals: string[] = [];
  let position = from;
  for (;;) {
    const group = readGroup(text, position, '[', ']');
    if (group === null) return { end: position, optionals };
    optionals.push(group.content);
    position = group.end;
  }
}

/**
 * Yields every control word outside comments and verbatim material, in
 * order. `\verb` arguments and verbatim environments are skipped.
 */
export function* scanCommands(text: string): Generator<CommandToken> {
  let position = 0;
  while (position < text.length) {
    const char = text[position];
    if (char === '%') {
      position = endOfLine(text, position);
      continue;
    }
    if (char !== '\\') {
      position += 1;
      continue;
    }
    const start = position;
    let end = position + 1;
    while (end < text.length && isLetter(text.charCodeAt(end))) end += 1;
    if (end === position + 1) {
      // Control symbol such as \% or \\: never a command we index.
      position += 2;
      continue;
    }
    const name = text.slice(position + 1, end);
    if (name === 'verb' || name === 'lstinline') {
      position = skipInlineVerbatim(text, end);
      continue;
    }
    const starred = text[end] === '*';
    if (starred) end += 1;

    if (name === 'begin') {
      const environment = readGroup(text, end);
      if (environment !== null && VERBATIM_ENVIRONMENTS.has(environment.content)) {
        const closing = text.indexOf(`\\end{${environment.content}}`, environment.end);
        position = closing === -1 ? text.length : closing;
        yield { name, start, end, starred };
        continue;
      }
    }
    yield { name, start, end, starred };
    position = end;
  }
}

/** Skips `\verb|...|` or `\verb*|...|`, whose delimiter is any character. */
function skipInlineVerbatim(text: string, from: number): number {
  let position = from;
  if (text[position] === '*') position += 1;
  if (text[position] === '[') {
    // \lstinline[style]{...}
    const optional = readGroup(text, position, '[', ']');
    if (optional !== null) position = optional.end;
  }
  const delimiter = text[position];
  if (delimiter === undefined) return position;
  const closing = delimiter === '{' ? '}' : delimiter;
  const end = text.indexOf(closing, position + 1);
  const newline = text.indexOf('\n', position + 1);
  // An unterminated \verb stops at the end of the line, as in TeX.
  if (end === -1 || (newline !== -1 && newline < end)) {
    return newline === -1 ? text.length : newline;
  }
  return end + 1;
}

/** Maps offsets to 1-based line numbers. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
      this.starts.push(index + 1);
    }
  }

  /** 1-based line of `offset`. */
  lineOf(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }
}
