import { describe, expect, it } from 'vitest';
import { parseBibliography } from './parse.js';

describe('parseBibliography', () => {
  it('reads keys, titles, family names, years and lines', () => {
    const entries = parseBibliography(
      [
        '% A comment line',
        '@string{jan = "January"}',
        '@article{knuth84,',
        "  author = {Donald E. Knuth and {\\'E}mile Zola},",
        '  title = {Literate {P}rogramming},',
        '  year = 1984, month = jan,',
        '}',
        '@book{edited, editor = {Ada Lovelace}, title = {Notes}, date = {1843-09}}',
      ].join('\n'),
    );
    expect(entries).toEqual([
      {
        key: 'knuth84',
        type: 'article',
        title: 'Literate Programming',
        authors: ['Knuth', 'Zola'],
        year: '1984',
        line: 3,
      },
      { key: 'edited', type: 'book', title: 'Notes', authors: ['Lovelace'], year: '1843', line: 8 },
    ]);
  });

  it('keeps the valid entries of a malformed file', () => {
    const entries = parseBibliography(
      '@book{broken, title = {No closing}\n@misc{fine, title = "Fine"}\n',
    );
    expect(entries.map((entry) => entry.key)).toContain('fine');
  });

  it('returns nothing for an empty or non-BibTeX file', () => {
    expect(parseBibliography('')).toEqual([]);
    expect(parseBibliography('just some text')).toEqual([]);
  });
});
