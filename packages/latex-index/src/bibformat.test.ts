import { describe, expect, it } from 'vitest';
import { firstAuthor, formatBibtex } from './bibformat.js';

const SOURCE = `% Bibliography of the thesis

@string{acm = "ACM Press"}

@Book{knuth1984,
  title={The {\\TeX}book},
  Author = {Knuth, Donald E.},
  publisher = acm # " (reprint)", year = 1984
}

% Read in 2025
@article{ lamport1986 ,
  year = {1986},
  author = {Leslie Lamport and Someone Else},
  title = "A {D}ocument {P}reparation {S}ystem",
}
@misc{anonymous, note = {No author}}
`;

describe('formatBibtex', () => {
  it('formats fields one per line, in a conventional order, values untouched', () => {
    expect(formatBibtex(SOURCE, { sort: 'none', align: true })).toBe(`% Bibliography of the thesis

@string{acm = "ACM Press"}

@book{knuth1984,
  author    = {Knuth, Donald E.},
  title     = {The {\\TeX}book},
  publisher = acm # " (reprint)",
  year      = 1984,
}

% Read in 2025
@article{lamport1986,
  author = {Leslie Lamport and Someone Else},
  title  = "A {D}ocument {P}reparation {S}ystem",
  year   = {1986},
}

@misc{anonymous,
  note = {No author},
}
`);
  });

  it('sorts by key, by first author and by year, entries without the value last', () => {
    const keys = (sort: 'key' | 'author' | 'year') =>
      [
        ...(formatBibtex(SOURCE, { sort, align: false }) ?? '').matchAll(/^@\w+\{([^,\s]+),$/gm),
      ].map((match) => match[1]);
    expect(keys('key')).toEqual(['anonymous', 'knuth1984', 'lamport1986']);
    expect(keys('author')).toEqual(['knuth1984', 'lamport1986', 'anonymous']);
    expect(keys('year')).toEqual(['knuth1984', 'lamport1986', 'anonymous']);
  });

  it('keeps comments with the entry that follows them', () => {
    const sorted = formatBibtex(SOURCE, { sort: 'key', align: false }) ?? '';
    expect(sorted).toContain('% Read in 2025\n@article{lamport1986,');
    expect(sorted.startsWith('% Bibliography of the thesis\n\n@string')).toBe(true);
  });

  it('refuses a file with syntax errors, but formats duplicate keys', () => {
    expect(formatBibtex('@book{a, title = {Open', { sort: 'key', align: true })).toBeNull();
    expect(formatBibtex('@book{a, x=1}\n@book{a, x=2}', { sort: 'none', align: false })).toBe(
      '@book{a,\n  x = 1,\n}\n\n@book{a,\n  x = 2,\n}\n',
    );
  });

  it('is stable: formatting twice gives the same text', () => {
    const once = formatBibtex(SOURCE, { sort: 'author', align: true }) ?? '';
    expect(formatBibtex(once, { sort: 'author', align: true })).toBe(once);
  });
});

describe('firstAuthor', () => {
  it('reads "Family, Given" and "Given Family" forms', () => {
    expect(firstAuthor({ fields: [{ name: 'author', value: '{Knuth, Donald}' }] })).toBe('knuth');
    expect(
      firstAuthor({ fields: [{ name: 'author', value: '{Leslie Lamport and B. Other}' }] }),
    ).toBe('lamport');
    expect(firstAuthor({ fields: [{ name: 'editor', value: '{Ada Lovelace}' }] })).toBe('lovelace');
  });
});
