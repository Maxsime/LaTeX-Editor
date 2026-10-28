import { checkBibtex } from './bibtex.js';

/** Order of the entries after formatting; `none` keeps the file's order. */
export type BibSort = 'none' | 'key' | 'author' | 'year';

export interface BibFormatOptions {
  sort: BibSort;
  /** Pads field names so that the `=` signs line up within each entry. */
  align: boolean;
}

interface Field {
  name: string;
  /** Value exactly as written: braces, quotes, macros and `#` concatenations. */
  value: string;
}

interface Entry {
  type: string;
  key: string;
  fields: Field[];
  /** Comments and free text found before the entry, kept with it. */
  leading: string;
}

/** Fields in the order most styles print them; others follow in their own order. */
const FIELD_ORDER = [
  'author',
  'editor',
  'title',
  'subtitle',
  'booktitle',
  'journal',
  'journaltitle',
  'series',
  'volume',
  'number',
  'pages',
  'edition',
  'chapter',
  'publisher',
  'institution',
  'school',
  'organization',
  'address',
  'location',
  'year',
  'month',
  'date',
  'isbn',
  'issn',
  'doi',
  'url',
  'urldate',
  'eprint',
  'eprinttype',
  'keywords',
  'abstract',
  'note',
];
const FIELD_RANK = new Map(FIELD_ORDER.map((name, index) => [name, index]));

class Scanner {
  position = 0;
  constructor(readonly text: string) {}

  skipSpace(): void {
    while (/\s/.test(this.text[this.position] ?? '')) this.position += 1;
  }

  /** Moves past a balanced group opened at the position by `open`. */
  group(open: string, close: string): void {
    let depth = 0;
    while (this.position < this.text.length) {
      const char = this.text[this.position];
      this.position += 1;
      if (char === '\\') this.position += 1;
      else if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  quoted(): void {
    let depth = 0;
    this.position += 1;
    while (this.position < this.text.length) {
      const char = this.text[this.position];
      this.position += 1;
      if (char === '\\') this.position += 1;
      else if (char === '{') depth += 1;
      else if (char === '}') depth = Math.max(0, depth - 1);
      else if (char === '"' && depth === 0) return;
    }
  }

  /** Raw text of a value, up to the comma or closing delimiter that ends it. */
  value(): string {
    this.skipSpace();
    const start = this.position;
    for (;;) {
      const char = this.text[this.position];
      if (char === '{') this.group('{', '}');
      else if (char === '"') this.quoted();
      else this.position += /^[^\s,#{}()"=]*/.exec(this.text.slice(this.position))?.[0].length ?? 0;
      const end = this.position;
      this.skipSpace();
      if (this.text[this.position] !== '#') return this.text.slice(start, end);
      this.position += 1;
      this.skipSpace();
    }
  }
}

/** Reads a file that `checkBibtex` found valid; free text goes with the next entry. */
function readEntries(text: string): {
  header: string;
  entries: Entry[];
  specials: string[];
  trailing: string;
} {
  const scanner = new Scanner(text);
  const entries: Entry[] = [];
  const specials: string[] = [];
  // Text before the first `@` describes the whole file and stays at the top.
  const first = text.indexOf('@');
  const header = first === -1 ? '' : text.slice(0, first).trim();
  scanner.position = Math.max(first, 0);
  let pending = '';
  while (scanner.position < text.length) {
    const at = text.indexOf('@', scanner.position);
    if (at === -1) break;
    pending += text.slice(scanner.position, at);
    scanner.position = at + 1;
    const type = /^[A-Za-z]+/.exec(text.slice(scanner.position))?.[0] ?? '';
    scanner.position += type.length;
    scanner.skipSpace();
    const open = text[scanner.position];
    if (type === '' || (open !== '{' && open !== '(')) {
      pending += text.slice(at, scanner.position);
      continue;
    }
    const close = open === '{' ? '}' : ')';
    const lower = type.toLowerCase();
    if (lower === 'comment' || lower === 'string' || lower === 'preamble') {
      scanner.group(open, close);
      const raw = text.slice(at, scanner.position);
      if (lower === 'comment') pending += raw;
      else specials.push(raw);
      continue;
    }
    scanner.position += 1;
    scanner.skipSpace();
    const key = /^[^\s,{}()"#%'=~\\]+/.exec(text.slice(scanner.position))?.[0] ?? '';
    scanner.position += key.length;
    scanner.skipSpace();
    const fields: Field[] = [];
    if (text[scanner.position] === ',') scanner.position += 1;
    for (;;) {
      scanner.skipSpace();
      if (text[scanner.position] === close || scanner.position >= text.length) {
        scanner.position += 1;
        break;
      }
      const name = /^[^\s,={}()"#]+/.exec(text.slice(scanner.position))?.[0] ?? '';
      scanner.position += name.length;
      scanner.skipSpace();
      scanner.position += 1; // `=`
      fields.push({ name: name.toLowerCase(), value: scanner.value() });
      scanner.skipSpace();
      if (text[scanner.position] === ',') scanner.position += 1;
    }
    entries.push({ type: lower, key, fields, leading: pending.trim() });
    pending = '';
  }
  pending += text.slice(scanner.position);
  return { header, entries, specials, trailing: pending.trim() };
}

/** Text of a field value without its outer delimiters and inner braces. */
function plain(value: string | undefined): string {
  return (value ?? '').replace(/[{}"]/g, '').replace(/\s+/g, ' ').trim();
}

/** Family name of the first author (or editor), lowercased, for sorting. */
export function firstAuthor(entry: { fields: readonly Field[] }): string {
  const names =
    entry.fields.find((field) => field.name === 'author')?.value ??
    entry.fields.find((field) => field.name === 'editor')?.value;
  const first = plain(names).split(/\s+and\s+/i)[0] ?? '';
  const family = first.includes(',')
    ? (first.split(',')[0] ?? '')
    : (first.split(' ').at(-1) ?? '');
  return family.trim().toLocaleLowerCase();
}

function yearOf(entry: Entry): string {
  const year = plain(entry.fields.find((field) => field.name === 'year')?.value);
  if (/^\d{4}/.test(year)) return year.slice(0, 4);
  return (
    /^\d{4}/.exec(plain(entry.fields.find((field) => field.name === 'date')?.value))?.[0] ?? ''
  );
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function compareEntries(sort: BibSort): ((a: Entry, b: Entry) => number) | null {
  const byKey = (a: Entry, b: Entry) => collator.compare(a.key, b.key);
  // Entries without the sorting value go last, in key order.
  const by = (value: (entry: Entry) => string) => (a: Entry, b: Entry) => {
    const left = value(a);
    const right = value(b);
    if (left === '' && right !== '') return 1;
    if (right === '' && left !== '') return -1;
    return collator.compare(left, right) || byKey(a, b);
  };
  if (sort === 'key') return byKey;
  if (sort === 'author') return by(firstAuthor);
  if (sort === 'year') return by(yearOf);
  return null;
}

function formatEntry(entry: Entry, align: boolean): string {
  const fields = entry.fields
    .map((field, index) => ({ field, index }))
    .sort(
      (a, b) =>
        (FIELD_RANK.get(a.field.name) ?? FIELD_ORDER.length) -
          (FIELD_RANK.get(b.field.name) ?? FIELD_ORDER.length) || a.index - b.index,
    )
    .map(({ field }) => field);
  const width = align ? Math.max(0, ...fields.map((field) => field.name.length)) : 0;
  const lines = fields.map((field) => `  ${field.name.padEnd(width)} = ${field.value},`);
  const body = [`@${entry.type}{${entry.key},`, ...lines, '}'].join('\n');
  return entry.leading === '' ? body : `${entry.leading}\n${body}`;
}

/**
 * Sorts and formats a BibTeX or BibLaTeX file: one field per line in a
 * conventional order, lowercase types and field names, values kept exactly
 * as written. `@string` and `@preamble` move to the top; comments stay with
 * the entry that follows them.
 *
 * @returns the formatted text, or null when the file has syntax errors and
 * reordering it could lose text.
 */
export function formatBibtex(text: string, options: BibFormatOptions): string | null {
  if (checkBibtex(text).issues.some((issue) => !issue.code.startsWith('duplicateKey'))) {
    return null;
  }
  const { header, entries, specials, trailing } = readEntries(text);
  const compare = compareEntries(options.sort);
  const ordered = compare === null ? entries : [...entries].sort(compare);
  const blocks = [
    ...(header === '' ? [] : [header]),
    ...specials,
    ...ordered.map((entry) => formatEntry(entry, options.align)),
    ...(trailing === '' ? [] : [trailing]),
  ];
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}
