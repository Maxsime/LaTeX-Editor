import { checkBibtex } from '@galley/latex-index';
import { ApiError, type ImportedEntry } from '@galley/shared';
import { buildKey, freeKey } from './keys.js';
import { parseBibliography } from './parse.js';
import { type Reference, toBibtex } from './reference.js';

/** How keys of imported entries are chosen. */
export interface KeyOptions {
  /** The project's key motif. */
  pattern: string;
  /** Keys already used in the project; filled with the keys given out. */
  taken: Set<string>;
  /** Keep the keys of pasted BibTeX when they are free. */
  keepKeys?: boolean;
}

function namesOf(reference: Reference): string[] {
  const people = reference.authors.length > 0 ? reference.authors : reference.editors;
  return people.map((person) => person.family);
}

/** Writes a looked-up reference as an entry under a fresh key. */
export function entryFromReference(reference: Reference, options: KeyOptions): ImportedEntry {
  const names = namesOf(reference);
  const key = freeKey(
    buildKey(options.pattern, { names, title: reference.title, year: reference.year }),
    options.taken,
  );
  return {
    key,
    type: reference.type,
    title: reference.title,
    authors: names,
    year: reference.year,
    bibtex: toBibtex(reference, key),
  };
}

/** Entry types of a `.bib` file that are not references. */
const NOT_REFERENCES = new Set(['comment', 'string', 'preamble']);

/**
 * Splits pasted BibTeX (or a Zotero export) into its entries and gives each a
 * key from the project's motif, or keeps its own when asked and free. The
 * entries are kept as written otherwise; `@string` macros they use are copied
 * in front of the first one.
 */
export function entriesFromBibtex(text: string, options: KeyOptions): ImportedEntry[] {
  const { entries } = checkBibtex(text);
  const metadata = new Map(parseBibliography(text).map((entry) => [entry.key, entry]));
  const strings = [...text.matchAll(/^[ \t]*@string\s*[{(][^\n]*$/gim)].map((match) =>
    match[0].trim(),
  );
  const imported: ImportedEntry[] = [];
  for (const entry of entries) {
    if (NOT_REFERENCES.has(entry.type)) continue;
    const meta = metadata.get(entry.key);
    const wanted =
      options.keepKeys === true
        ? entry.key
        : buildKey(options.pattern, {
            names: meta?.authors ?? [],
            title: meta?.title ?? null,
            year: meta?.year ?? null,
          });
    const key = freeKey(wanted, options.taken);
    const source = text.slice(entry.start, entry.end).trimEnd();
    const bibtex =
      source.slice(0, entry.from - entry.start) + key + source.slice(entry.to - entry.start);
    imported.push({
      key,
      type: entry.type,
      title: meta?.title ?? null,
      authors: meta?.authors ?? [],
      year: meta?.year ?? null,
      bibtex: `${bibtex}\n`,
    });
  }
  const first = imported[0];
  if (first === undefined) throw new ApiError('REFERENCE_NOT_FOUND', 'no entry in the text');
  if (strings.length > 0) first.bibtex = `${strings.join('\n')}\n${first.bibtex}`;
  return imported;
}
