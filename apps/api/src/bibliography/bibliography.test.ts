import { readFileSync } from 'node:fs';
import { checkBibtex } from '@galley/latex-index';
import { describe, expect, it } from 'vitest';
import { entriesFromBibtex, entryFromReference } from './import.js';
import { asciiFold, buildKey, freeKey, unknownKeyTokens } from './keys.js';
import { protectTitle, splitName, toBibtex } from './reference.js';
import {
  normaliseArxiv,
  normaliseDoi,
  normaliseIsbn,
  parseArxiv,
  parseCrossref,
  parseOpenLibrary,
} from './sources.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/lookup/${name}`, import.meta.url), 'utf8');

const PATTERN = '[auth:lower][year][shorttitle:lower]';

describe('identifiers', () => {
  it('normalises DOIs, arXiv ids and ISBNs from their usual spellings', () => {
    expect(normaliseDoi('https://doi.org/10.1093/comjnl/27.2.97')).toBe('10.1093/comjnl/27.2.97');
    expect(normaliseDoi('doi:10.1000/xyz')).toBe('10.1000/xyz');
    expect(normaliseArxiv('https://arxiv.org/abs/1706.03762v7')).toBe('1706.03762v7');
    expect(normaliseArxiv('arXiv:hep-th/9901001')).toBe('hep-th/9901001');
    expect(normaliseIsbn('978-0-201-13447-6')).toBe('9780201134476');
    expect(normaliseIsbn('0-201-13447-0')).toBe('0201134470');
  });

  it('refuses malformed identifiers and wrong check digits', () => {
    expect(() => normaliseDoi('11.1000/x')).toThrow();
    expect(() => normaliseDoi('10.1000/../../admin')).toThrow();
    expect(() => normaliseArxiv('1706.037')).toThrow();
    expect(() => normaliseIsbn('978-0-201-13447-5')).toThrow();
  });
});

describe('services', () => {
  it('reads a Crossref journal article', () => {
    const reference = parseCrossref(fixture('crossref-10.1093_comjnl_27.2.97.json'));
    expect(reference).toMatchObject({
      type: 'article',
      title: 'Literate Programming',
      authors: [{ family: 'Knuth', given: 'D. E.' }],
      year: '1984',
      journal: 'The Computer Journal',
      volume: '27',
      number: '2',
      pages: '97-111',
      doi: '10.1093/comjnl/27.2.97',
    });
    expect(reference.publisher).toBeUndefined();
  });

  it('reads arXiv feeds, and reports an unknown identifier', () => {
    const reference = parseArxiv(fixture('arxiv-1706.03762.xml'), '1706.03762');
    expect(reference).toMatchObject({
      type: 'misc',
      title: 'Attention Is All You Need',
      year: '2017',
      eprint: '1706.03762',
      archiveprefix: 'arXiv',
      primaryclass: 'cs.CL',
    });
    expect(reference.authors).toHaveLength(8);
    expect(reference.authors[5]).toEqual({ family: 'Gomez', given: 'Aidan N.' });
    expect(() => parseArxiv(fixture('arxiv-missing.xml'), '9999.99999')).toThrow(
      /REFERENCE_NOT_FOUND/,
    );
  });

  it('reads Open Library books', () => {
    const reference = parseOpenLibrary(fixture('openlibrary-9780201134476.json'), '9780201134476');
    expect(reference).toMatchObject({
      type: 'book',
      title: 'The TeXbook',
      authors: [{ family: 'Knuth', given: 'Donald E.' }],
      year: '1984',
      publisher: 'Addison-Wesley',
      address: 'Reading, Mass',
      isbn: '9780201134476',
    });
    expect(() => parseOpenLibrary('{}', '9780201134476')).toThrow(/REFERENCE_NOT_FOUND/);
  });

  it('treats an answer of the wrong shape as an unavailable service', () => {
    expect(() => parseCrossref('{"message": {"title": "not a list"}}')).toThrow(/unexpected/);
    expect(() => parseCrossref('<html>')).toThrow(/malformed/);
  });
});

describe('BibTeX writing', () => {
  it('writes a valid entry, escaping special characters but not DOIs', () => {
    const reference = parseCrossref(fixture('crossref-escaping.json'));
    const bibtex = toBibtex(reference, 'lefevre2021fast');
    expect(checkBibtex(bibtex).issues).toEqual([]);
    expect(bibtex).toContain(
      'author    = {Lefèvre, Élodie and van der Berg, Jan and {CERN Collaboration}}',
    );
    expect(bibtex).toContain(
      'title     = {Fast {k-NN} search \\& {DNA} indexing at 100\\% recall: a study of R\\_2 trees}',
    );
    expect(bibtex).toContain('booktitle = {Proceedings of the 12th Symposium on Data \\& Systems}');
    expect(bibtex).toContain('pages     = {10--20}');
    expect(bibtex).toContain('doi       = {10.1145/1234567.8901234}');
    expect(bibtex.startsWith('@inproceedings{lefevre2021fast,\n')).toBe(true);
  });

  it('braces words with inner capitals only', () => {
    expect(protectTitle('Using LaTeX for DNA and Math')).toBe('Using {LaTeX} for {DNA} and Math');
  });

  it('splits names, keeping particles with the family name', () => {
    expect(splitName('Ludwig van Beethoven')).toEqual({ family: 'van Beethoven', given: 'Ludwig' });
    expect(splitName('Plato')).toEqual({ family: 'Plato' });
  });
});

describe('citation keys', () => {
  const source = {
    names: ['Lefèvre', 'Østergaard', 'Smith'],
    title: 'The Art of Ćomputing',
    year: '2021-05',
  };

  it('builds keys from the pattern', () => {
    expect(buildKey(PATTERN, source)).toBe('lefevre2021art');
    expect(buildKey('[authors2]_[year]', source)).toBe('LefevreEtAl_2021');
    expect(buildKey('[auth:upper]:[title3]', source)).toBe('LEFEVRE:ArtComputing');
    expect(buildKey('[auth]', { names: [], title: null, year: null })).toBe('ref');
    expect(asciiFold('Œuvre ß')).toBe('OEuvress');
  });

  it('lists unknown tokens and modifiers', () => {
    expect(unknownKeyTokens(PATTERN)).toEqual([]);
    expect(unknownKeyTokens('[auth:camel][journal]')).toEqual(['auth:camel', 'journal']);
  });

  it('suffixes keys already taken, ignoring case', () => {
    const taken = new Set(['knuth1984literate']);
    expect(freeKey('Knuth1984literate', taken)).toBe('Knuth1984literatea');
    expect(freeKey('knuth1984literate', taken)).toBe('knuth1984literateb');
    expect(freeKey('other', taken)).toBe('other');
  });
});

describe('imports', () => {
  it('turns a reference into an entry under a free key', () => {
    const reference = parseCrossref(fixture('crossref-10.1093_comjnl_27.2.97.json'));
    const entry = entryFromReference(reference, { pattern: PATTERN, taken: new Set() });
    expect(entry.key).toBe('knuth1984literate');
    expect(entry.bibtex).toMatch(/^@article\{knuth1984literate,/);
  });

  it('re-keys pasted BibTeX, or keeps its keys, and copies its @string macros', () => {
    const pasted = `% exported
@string{cj = {The Computer Journal}}
@article{K84, author = {Knuth, Donald E.}, title = {Literate Programming}, journal = cj, year = 1984}
@book{lamport, author = {Leslie Lamport}, title = {{LaTeX}: A Document Preparation System}, year = {1994}}
`;
    const taken = new Set(['lamport']);
    const entries = entriesFromBibtex(pasted, { pattern: PATTERN, taken });
    expect(entries.map((entry) => entry.key)).toEqual(['knuth1984literate', 'lamport1994latex']);
    expect(entries[0]?.bibtex).toMatch(
      /^@string\{cj = \{The Computer Journal\}\}\n@article\{knuth1984literate,/,
    );
    const kept = entriesFromBibtex(pasted, {
      pattern: PATTERN,
      taken: new Set(['lamport']),
      keepKeys: true,
    });
    expect(kept.map((entry) => entry.key)).toEqual(['K84', 'lamporta']);
    expect(() =>
      entriesFromBibtex('nothing here', { pattern: PATTERN, taken: new Set() }),
    ).toThrow();
  });
});

describe('corpus project 13-doi-import', () => {
  it('holds exactly what importing its DOI writes', () => {
    const reference = parseCrossref(fixture('crossref-10.1093_comjnl_27.2.97.json'));
    const entry = entryFromReference(reference, { pattern: PATTERN, taken: new Set() });
    const corpus = readFileSync(
      new URL('../../../../fixtures/projects/13-doi-import/references.bib', import.meta.url),
      'utf8',
    );
    expect(corpus).toBe(entry.bibtex);
  });
});
