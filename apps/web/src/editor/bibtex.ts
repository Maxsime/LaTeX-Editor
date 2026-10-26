import type { StreamParser, StringStream } from '@codemirror/language';

interface BibState {
  /** Inside an entry, between its braces. */
  inEntry: boolean;
  /** Brace depth inside a field value. */
  depth: number;
  /** Next token in an entry is its citation key. */
  expectKey: boolean;
  /** Inside a double-quoted value. */
  inQuote: boolean;
}

/** Consumes a braced or quoted value, possibly over several lines. */
function readValue(stream: StringStream, state: BibState): string {
  while (!stream.eol()) {
    const char = stream.next();
    if (char === '\\') stream.next();
    else if (state.inQuote && state.depth === 0 && char === '"') {
      state.inQuote = false;
      return 'string';
    } else if (char === '{') state.depth += 1;
    else if (char === '}') {
      state.depth -= 1;
      if (state.depth === 0 && !state.inQuote) return 'string';
    }
  }
  return 'string';
}

/**
 * Small BibTeX tokenizer: entry types, citation keys, field names, braced and
 * quoted values, numbers and `%` comments outside entries.
 */
export const bibtex: StreamParser<BibState> = {
  name: 'bibtex',
  startState: () => ({ inEntry: false, depth: 0, expectKey: false, inQuote: false }),
  token(stream: StringStream, state: BibState): string | null {
    if (state.depth > 0 || state.inQuote) return readValue(stream, state);
    if (stream.eatSpace()) return null;
    if (!state.inEntry) {
      if (stream.match(/^@[a-zA-Z]+/)) return 'keyword';
      if (stream.eat('{') || stream.eat('(')) {
        state.inEntry = true;
        state.expectKey = true;
        return 'bracket';
      }
      // Text between entries is ignored by BibTeX: show it as a comment.
      stream.skipToEnd();
      return 'comment';
    }
    if (state.expectKey && stream.match(/^[^,\s}]+/)) {
      state.expectKey = false;
      return 'labelName';
    }
    if (stream.match(/^[a-zA-Z][\w-]*(?=\s*=)/)) return 'propertyName';
    if (stream.match(/^\d+/)) return 'number';
    const char = stream.next();
    if (char === '{') {
      state.depth = 1;
      return readValue(stream, state);
    }
    if (char === '"') {
      state.inQuote = true;
      return readValue(stream, state);
    }
    if (char === '}' || char === ')') {
      state.inEntry = false;
      state.expectKey = false;
      return 'bracket';
    }
    if (char === '=' || char === ',' || char === '#') return 'punctuation';
    if (char !== undefined && /[a-zA-Z]/.test(char)) {
      stream.match(/^[\w-]*/);
      return 'variableName';
    }
    return null;
  },
  languageData: { commentTokens: { line: '%' } },
};
