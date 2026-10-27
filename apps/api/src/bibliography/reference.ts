/** A person or an organisation (`literal`), as bibliographic services describe them. */
export interface Person {
  family: string;
  given?: string;
  /** An organisation: written as one braced name. */
  literal?: boolean;
}

/** Entry types written; each is valid for both BibTeX styles and Biber. */
export type ReferenceType =
  'article' | 'inproceedings' | 'incollection' | 'book' | 'phdthesis' | 'techreport' | 'misc';

/** Metadata of a work, independent of where it came from. */
export interface Reference {
  type: ReferenceType;
  title: string | null;
  authors: Person[];
  editors: Person[];
  year: string | null;
  journal?: string;
  booktitle?: string;
  volume?: string;
  number?: string;
  pages?: string;
  publisher?: string;
  address?: string;
  institution?: string;
  school?: string;
  isbn?: string;
  doi?: string;
  url?: string;
  eprint?: string;
  archiveprefix?: string;
  primaryclass?: string;
  note?: string;
}

const SPECIALS: Readonly<Record<string, string>> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/** Escapes the characters TeX would read as commands; Unicode stays as is (Biber reads UTF-8). */
export function escapeLatex(value: string): string {
  return value.replace(/[\\{}&%$#_~^]/g, (char) => SPECIALS[char] ?? char);
}

/** Collapses whitespace and strips the HTML or JATS tags some services put in titles. */
export function cleanText(value: string): string {
  return value
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Escapes a title and braces its acronyms and proper nouns with inner capitals
 * (`{DNA}`, `{LaTeX}`), so that styles lowering the case of titles keep them.
 */
export function protectTitle(title: string): string {
  return title
    .split(/(\s+)/)
    .map((word) => {
      const escaped = escapeLatex(word);
      return /\p{Lu}/u.test(word.slice(1)) ? `{${escaped}}` : escaped;
    })
    .join('');
}

function formatPerson(person: Person): string {
  if (person.literal === true) return `{${escapeLatex(person.family)}}`;
  const family = escapeLatex(person.family);
  // A family name holding a comma or " and " would be split by BibTeX: keep it whole.
  const safeFamily = /,|\sand\s/i.test(person.family) ? `{${family}}` : family;
  return person.given === undefined || person.given === ''
    ? safeFamily
    : `${safeFamily}, ${escapeLatex(person.given)}`;
}

function formatPeople(people: readonly Person[]): string {
  return people.map(formatPerson).join(' and ');
}

/** Verbatim fields: biblatex and the url package read them raw, so they are not escaped. */
function verbatim(value: string): string {
  return value.replace(/[{}\s\\%]/g, '');
}

/** Writes `reference` as a BibTeX entry under `key`, one field per line. */
export function toBibtex(reference: Reference, key: string): string {
  const fields: [string, string][] = [];
  const add = (name: string, value: string | undefined | null, raw = false) => {
    if (value === undefined || value === null || value.trim() === '') return;
    fields.push([name, raw ? value : escapeLatex(value)]);
  };
  if (reference.authors.length > 0) fields.push(['author', formatPeople(reference.authors)]);
  if (reference.editors.length > 0) fields.push(['editor', formatPeople(reference.editors)]);
  if (reference.title !== null) add('title', protectTitle(reference.title), true);
  add('journal', reference.journal);
  add('booktitle', reference.booktitle);
  add('year', reference.year);
  add('volume', reference.volume);
  add('number', reference.number);
  add('pages', reference.pages?.replace(/\s*[-–—]+\s*/g, '--'), true);
  add('publisher', reference.publisher);
  add('address', reference.address);
  add('institution', reference.institution);
  add('school', reference.school);
  add('isbn', reference.isbn);
  add('doi', reference.doi === undefined ? undefined : verbatim(reference.doi), true);
  add('url', reference.url === undefined ? undefined : verbatim(reference.url), true);
  add('eprint', reference.eprint === undefined ? undefined : verbatim(reference.eprint), true);
  add('archiveprefix', reference.archiveprefix);
  add('primaryclass', reference.primaryclass);
  add('note', reference.note);
  const width = Math.max(...fields.map(([name]) => name.length));
  const body = fields.map(([name, value]) => `  ${name.padEnd(width)} = {${value}},`).join('\n');
  return `@${reference.type}{${key},\n${body}\n}\n`;
}

/**
 * Splits a full name written "Given Family" into its parts. Lower-case
 * particles before the last word belong to the family name ("van Gogh").
 */
export function splitName(name: string): Person {
  const words = cleanText(name)
    .split(' ')
    .filter((word) => word !== '');
  if (words.length <= 1) return { family: words[0] ?? '' };
  let start = words.length - 1;
  while (start > 1 && /^\p{Ll}/u.test(words[start - 1] ?? '')) start -= 1;
  return { family: words.slice(start).join(' '), given: words.slice(0, start).join(' ') };
}
