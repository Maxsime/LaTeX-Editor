import { describe, expect, it } from 'vitest';
import { appendedBlock, filterReferences, joinEntries, parseRules } from './writing.js';

const entry = (key: string, title: string, authors: string[], year: string) => ({
  key,
  type: 'article',
  title,
  authors,
  year,
  fileId: 'f',
  line: 1,
});

describe('references', () => {
  const index = {
    citations: [
      entry('knuth1984literate', 'Literate Programming', ['Knuth'], '1984'),
      entry('lamport1994', 'LaTeX: A Document Preparation System', ['Lamport'], '1994'),
      entry('dupont2024', 'Étude des systèmes', ['Dupont', 'Müller'], '2024'),
    ],
    cited: ['lamport1994'],
  };

  it('searches keys, titles, authors and years, accents aside', () => {
    expect(filterReferences(index, 'etude muller').map((row) => row.key)).toEqual(['dupont2024']);
    expect(filterReferences(index, '1984').map((row) => row.key)).toEqual(['knuth1984literate']);
    expect(filterReferences(index, '').map((row) => row.key)).toEqual([
      'dupont2024',
      'knuth1984literate',
      'lamport1994',
    ]);
  });

  it('tells cited entries apart', () => {
    expect(filterReferences(index, '', 'cited').map((row) => row.key)).toEqual(['lamport1994']);
    expect(filterReferences(index, '', 'uncited').map((row) => row.cited)).toEqual([false, false]);
  });

  it('appends entries after a blank line', () => {
    const block = joinEntries(['@book{a,\n}\n', '@book{b,\n}']);
    expect(block).toBe('@book{a,\n}\n\n@book{b,\n}');
    expect(appendedBlock('', block)).toBe(`${block}\n`);
    expect(appendedBlock('@x{y,}', '@b{c,}')).toBe('\n\n@b{c,}\n');
    expect(appendedBlock('@x{y,}\n', '@b{c,}')).toBe('\n@b{c,}\n');
    expect(appendedBlock('@x{y,}\n\n', '@b{c,}')).toBe('@b{c,}\n');
  });
});

describe('chktex rules', () => {
  it('reads a typed list of rules', () => {
    expect(parseRules('8, 1 13;1')).toEqual([1, 8, 13]);
    expect(parseRules('')).toEqual([]);
    expect(parseRules('1, x')).toBeNull();
    expect(parseRules('120')).toBeNull();
  });
});
