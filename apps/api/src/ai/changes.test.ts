import { ToolError } from '@galley/ai';
import { describe, expect, it } from 'vitest';
import { buildHunks, citationViolations, knownCitationKeys } from './changes.js';

const texts = [
  { id: '00000000-0000-4000-8000-000000000001', path: 'main.tex', text: 'Un deux trois. Un deux.' },
  { id: '00000000-0000-4000-8000-000000000002', path: 'refs.bib', text: '@book{a, title={A}}' },
];
const none = new Set<string>();

describe('buildHunks', () => {
  it('locates a unique search text with its surroundings', () => {
    const [hunk] = buildHunks(texts, none, none, [
      { path: './main.tex', search: 'trois', replace: '3' },
    ]);
    expect(hunk).toMatchObject({
      path: 'main.tex',
      start: 8,
      original: 'trois',
      before: 'Un deux ',
      after: '. Un deux.',
    });
  });

  it('asks the model to fix missing, ambiguous and overlapping searches', () => {
    expect(() =>
      buildHunks(texts, none, none, [{ path: 'main.tex', search: 'quatre', replace: '' }]),
    ).toThrow(/not found/);
    expect(() =>
      buildHunks(texts, none, none, [{ path: 'main.tex', search: 'Un deux', replace: '' }]),
    ).toThrow(/occurs 2 times/);
    expect(() =>
      buildHunks(texts, none, none, [
        { path: 'main.tex', search: 'deux trois', replace: '' },
        { path: 'main.tex', search: 'trois.', replace: '' },
      ]),
    ).toThrow(/overlap/);
  });

  it('appends with an empty search and creates source files only', () => {
    const [append] = buildHunks(texts, none, none, [
      { path: 'refs.bib', search: '', replace: '@misc{b,}' },
    ]);
    expect(append).toMatchObject({
      start: texts[1]?.text.length,
      original: '',
      replacement: '\n@misc{b,}',
    });
    const [created] = buildHunks(texts, none, none, [
      { path: 'chapitres/intro.tex', search: '', replace: 'x' },
    ]);
    expect(created).toMatchObject({ fileId: null, path: 'chapitres/intro.tex' });
    for (const path of ['image.png', '../evil.tex', 'a//b.tex/']) {
      expect(() => buildHunks(texts, none, none, [{ path, search: '', replace: 'x' }])).toThrow(
        ToolError,
      );
    }
    expect(() =>
      buildHunks(texts, none, new Set(['logo.pdf']), [
        { path: 'logo.pdf', search: 'x', replace: '' },
      ]),
    ).toThrow(/binary/);
    expect(() =>
      buildHunks(texts, new Set(['img']), none, [{ path: 'img', search: '', replace: '' }]),
    ).toThrow(/folder/);
    expect(() =>
      buildHunks(texts, none, none, [{ path: 'absent.tex', search: 'x', replace: '' }]),
    ).toThrow(/No text file/);
  });
});

describe('citationViolations', () => {
  const known = knownCitationKeys(
    [
      ...texts,
      {
        id: 'x',
        path: 'other.tex',
        text: '\\begin{thebibliography}{1}\\bibitem{item1} X\\end{thebibliography}',
      },
    ],
    [{ key: 'fetched1', bibtex: '@article{fetched1,\n  title = {F},\n}' }],
  );

  it('knows .bib entries, bibitems and fetched entries', () => {
    expect([...known].sort()).toEqual(['a', 'fetched1', 'item1']);
  });

  const hunk = (path: string, original: string, replacement: string) => ({
    id: 'h',
    fileId: null,
    path,
    start: 0,
    original,
    replacement,
    before: '',
    after: '',
  });

  it('refuses unknown keys, except those the replaced text already cited', () => {
    expect(citationViolations([hunk('a.tex', '', '\\cite{a,fetched1,item1}')], known, [])).toEqual(
      [],
    );
    expect(citationViolations([hunk('a.tex', '', '\\parencite{ghost}')], known, [])).toHaveLength(
      1,
    );
    expect(
      citationViolations([hunk('a.tex', '\\cite{old}', '\\cite{old} encore')], known, []),
    ).toEqual([]);
  });

  it('accepts only fetched entries in a .bib, whitespace aside', () => {
    const fetched = [{ key: 'fetched1', bibtex: '@article{fetched1,\n  title = {F},\n}' }];
    expect(
      citationViolations([hunk('r.bib', '', '@article{fetched1, title = {F}, }')], known, fetched),
    ).toEqual([]);
    expect(
      citationViolations([hunk('r.bib', '', '@article{fetched1, title = {G}, }')], known, fetched),
    ).toHaveLength(1);
    // Editing an entry already there is not adding one.
    expect(
      citationViolations([hunk('r.bib', '@book{a, title={A}}', '@book{a, title={B}}')], known, []),
    ).toEqual([]);
  });
});
