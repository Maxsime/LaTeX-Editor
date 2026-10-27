/** Problems found in a `.bib` file by {@link checkBibtex}. */
export type BibIssueCode =
  | 'missingKey'
  | 'unclosedEntry'
  | 'expectedComma'
  | 'expectedEquals'
  | 'expectedValue'
  | 'unclosedValue'
  | 'duplicateField'
  | 'duplicateKey'
  | 'duplicateKeyElsewhere';

export interface BibIssue {
  code: BibIssueCode;
  /** Field name or citation key the issue is about, when there is one. */
  name?: string;
  from: number;
  to: number;
}

/** An entry of the file, with the span of its citation key and of the whole entry. */
export interface BibKey {
  key: string;
  type: string;
  from: number;
  to: number;
  /** Offset of the entry's `@`. */
  start: number;
  /** Offset just after the entry, or where reading resumed after an error in it. */
  end: number;
}

export interface BibCheck {
  entries: BibKey[];
  issues: BibIssue[];
}

/** Entry types that hold no citation: skipped (comment) or checked as a value. */
const SPECIAL_TYPES = new Set(['comment', 'string', 'preamble']);

class BibReader {
  position = 0;
  readonly issues: BibIssue[] = [];
  readonly entries: BibKey[] = [];

  constructor(private readonly text: string) {}

  private peek(): string | undefined {
    return this.text[this.position];
  }

  private skipSpace(): void {
    while (this.position < this.text.length && /\s/.test(this.text[this.position] ?? '')) {
      this.position += 1;
    }
  }

  private issue(code: BibIssueCode, from: number, to = from + 1, name?: string): void {
    const end = Math.min(Math.max(to, from + 1), this.text.length);
    const start = Math.min(from, Math.max(end - 1, 0));
    this.issues.push(
      name === undefined ? { code, from: start, to: end } : { code, name, from: start, to: end },
    );
  }

  /** Next `@` that starts a line, where BibTeX itself resumes after an error. */
  private recover(): void {
    const match = /\n[ \t]*@/g;
    // From the previous character, so that an @ already reached at a line start counts.
    match.lastIndex = Math.max(0, this.position - 1);
    const found = match.exec(this.text);
    this.position = found === null ? this.text.length : found.index + found[0].length - 1;
  }

  /** Reads a balanced `{...}` at the position; false when it does not close. */
  private braced(): boolean {
    let depth = 0;
    while (this.position < this.text.length) {
      const char = this.text[this.position];
      this.position += 1;
      if (char === '\\') this.position += 1;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return true;
      } else if (char === '@' && this.text[this.position - 2] === '\n') {
        // A new entry at the start of a line: this value was never closed.
        this.position -= 1;
        return false;
      }
    }
    return false;
  }

  private quoted(): boolean {
    let depth = 0;
    this.position += 1;
    while (this.position < this.text.length) {
      const char = this.text[this.position];
      this.position += 1;
      if (char === '\\') this.position += 1;
      else if (char === '{') depth += 1;
      else if (char === '}') depth = Math.max(0, depth - 1);
      else if (char === '"' && depth === 0) return true;
      else if (char === '@' && this.text[this.position - 2] === '\n') {
        this.position -= 1;
        return false;
      }
    }
    return false;
  }

  /** A value: pieces joined by `#`. Returns false after reporting an issue. */
  private value(): boolean {
    for (;;) {
      this.skipSpace();
      const start = this.position;
      const char = this.peek();
      if (char === '{') {
        if (!this.braced()) {
          this.issue('unclosedValue', start);
          return false;
        }
      } else if (char === '"') {
        if (!this.quoted()) {
          this.issue('unclosedValue', start);
          return false;
        }
      } else {
        const match = /^[^\s,#{}()"=]+/.exec(this.text.slice(this.position, this.position + 200));
        if (match === null) {
          this.issue('expectedValue', start);
          return false;
        }
        this.position += match[0].length;
      }
      this.skipSpace();
      if (this.peek() !== '#') return true;
      this.position += 1;
    }
  }

  private entry(): void {
    const at = this.position;
    this.position += 1;
    const typeMatch = /^[A-Za-z]+/.exec(this.text.slice(this.position, this.position + 64));
    if (typeMatch === null) return; // A stray @ outside entries is a comment for BibTeX.
    const type = typeMatch[0].toLowerCase();
    this.position += typeMatch[0].length;
    this.skipSpace();
    const open = this.peek();
    if (open !== '{' && open !== '(') return;
    const close = open === '{' ? '}' : ')';
    if (type === 'comment') {
      if (open === '{' && !this.braced()) this.issue('unclosedEntry', at, this.position);
      return;
    }
    this.position += 1;
    if (SPECIAL_TYPES.has(type)) {
      this.skipSpace();
      if (type === 'string') this.fields(at, close, new Set());
      else if (!this.value()) this.recover();
      else this.expectClose(at, close);
      return;
    }
    this.skipSpace();
    const keyMatch = /^[^\s,{}()"#%'=~\\]+/.exec(
      this.text.slice(this.position, this.position + 256),
    );
    const looksLikeField =
      keyMatch !== null &&
      /^\s*=/.test(
        this.text.slice(
          this.position + keyMatch[0].length,
          this.position + keyMatch[0].length + 64,
        ),
      );
    if (keyMatch === null || looksLikeField) {
      this.issue('missingKey', at, this.position);
      if (keyMatch !== null) {
        // `@article{author = ...`: the fields are there, only the key is missing.
        this.fields(at, close, new Set());
      } else if (this.peek() === ',') {
        this.position += 1;
        this.fields(at, close, new Set());
      } else {
        this.recover();
      }
      return;
    }
    const key = keyMatch[0];
    this.entries.push({
      key,
      type,
      from: this.position,
      to: this.position + key.length,
      start: at,
      end: at,
    });
    this.position += key.length;
    this.skipSpace();
    if (this.peek() === close) {
      this.position += 1;
      return;
    }
    if (this.peek() !== ',') {
      this.issue('expectedComma', this.position);
      this.recover();
      return;
    }
    this.position += 1;
    this.fields(at, close, new Set());
  }

  private expectClose(at: number, close: string): void {
    this.skipSpace();
    if (this.peek() === close) this.position += 1;
    else {
      this.issue('unclosedEntry', at, at + 1);
      this.recover();
    }
  }

  /** `name = value` pairs up to the closing delimiter. */
  private fields(at: number, close: string, seen: Set<string>): void {
    for (;;) {
      this.skipSpace();
      const char = this.peek();
      if (char === close) {
        this.position += 1;
        return;
      }
      if (char === undefined || char === '@') {
        this.issue('unclosedEntry', at, at + 1);
        return;
      }
      const nameMatch = /^[^\s,={}()"#]+/.exec(this.text.slice(this.position, this.position + 128));
      if (nameMatch === null) {
        this.issue('expectedValue', this.position);
        this.recover();
        return;
      }
      const name = nameMatch[0].toLowerCase();
      const nameStart = this.position;
      this.position += nameMatch[0].length;
      if (seen.has(name)) this.issue('duplicateField', nameStart, this.position, nameMatch[0]);
      seen.add(name);
      this.skipSpace();
      if (this.peek() !== '=') {
        this.issue('expectedEquals', nameStart, this.position);
        this.recover();
        return;
      }
      this.position += 1;
      if (!this.value()) {
        this.recover();
        return;
      }
      this.skipSpace();
      const after = this.peek();
      if (after === ',') {
        this.position += 1;
        continue;
      }
      if (after === close) {
        this.position += 1;
        return;
      }
      const unclosed = after === undefined || after === '@';
      this.issue(unclosed ? 'unclosedEntry' : 'expectedComma', unclosed ? at : this.position);
      this.recover();
      return;
    }
  }

  read(): void {
    while (this.position < this.text.length) {
      const next = this.text.indexOf('@', this.position);
      if (next === -1) return;
      this.position = next;
      const count = this.entries.length;
      this.entry();
      const added = this.entries[count];
      if (added !== undefined) added.end = Math.max(this.position, added.to);
    }
  }
}

/**
 * Checks the syntax of a BibTeX or BibLaTeX file the way BibTeX and Biber
 * read it: everything outside entries is a comment, and after an error the
 * reading resumes at the next line that starts with `@`. Keys defined twice
 * in the file, or already defined in `otherKeys` (the project's other
 * bibliographies), are reported on each occurrence after the first.
 */
export function checkBibtex(text: string, otherKeys: ReadonlySet<string> = new Set()): BibCheck {
  const reader = new BibReader(text);
  reader.read();
  const seen = new Set<string>();
  for (const entry of reader.entries) {
    const folded = entry.key.toLowerCase();
    if (otherKeys.has(entry.key)) {
      reader.issues.push({
        code: 'duplicateKeyElsewhere',
        name: entry.key,
        from: entry.from,
        to: entry.to,
      });
    } else if (seen.has(folded)) {
      reader.issues.push({ code: 'duplicateKey', name: entry.key, from: entry.from, to: entry.to });
    }
    seen.add(folded);
  }
  reader.issues.sort((a, b) => a.from - b.from);
  return { entries: reader.entries, issues: reader.issues };
}
