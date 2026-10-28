import { ToolError } from '@galley/ai';
import { describe, expect, it } from 'vitest';
import { diffHunks, Draft } from './draft.js';

const MAIN_ID = '00000000-0000-4000-8000-000000000001';
const main = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Le chat dort.',
  'Le chien aboie.',
  'Fin.',
  '\\end{document}',
  '',
].join('\n');
const texts = [
  { id: MAIN_ID, path: 'main.tex', text: main },
  { id: '00000000-0000-4000-8000-000000000002', path: 'refs.bib', text: '@book{a, title={A}}\n' },
];
const none = new Set<string>();

/** Applies hunks located in `text`, as accepting every one would. */
function accept(
  text: string,
  hunks: readonly { start: number; original: string; replacement: string }[],
) {
  let result = text;
  for (const hunk of [...hunks].sort((left, right) => right.start - left.start)) {
    expect(result.slice(hunk.start, hunk.start + hunk.original.length)).toBe(hunk.original);
    result =
      result.slice(0, hunk.start) +
      hunk.replacement +
      result.slice(hunk.start + hunk.original.length);
  }
  return result;
}

describe('Draft', () => {
  it('lets later reads and edits see earlier edits, leaving the project as it was', () => {
    const draft = new Draft(texts);
    expect(
      draft.edit(
        [{ path: 'main.tex', search: 'Le chat dort.', replace: 'Le chat ronfle.' }],
        none,
        none,
        [],
      ),
    ).toEqual(['main.tex']);
    // The second edit searches text only the first one wrote.
    draft.edit([{ path: 'main.tex', search: 'ronfle', replace: 'ronfle fort' }], none, none, []);
    draft.edit(
      [{ path: 'chapitres/intro.tex', search: '', replace: 'Introduction.\n' }],
      none,
      none,
      [],
    );
    draft.edit([{ path: 'chapitres/intro.tex', search: '', replace: 'Suite.\n' }], none, none, []);
    const seen = new Map(draft.texts().map((file) => [file.path, file.text]));
    expect(seen.get('main.tex')).toContain('Le chat ronfle fort.');
    expect(seen.get('chapitres/intro.tex')).toBe('Introduction.\nSuite.\n');
    expect(draft.original().find((file) => file.path === 'main.tex')?.text).toBe(main);
    expect(draft.changedPaths().sort()).toEqual(['chapitres/intro.tex', 'main.tex']);
  });

  it('turns the draft into hunks that rebuild it from the project', () => {
    const draft = new Draft(texts);
    draft.edit(
      [
        { path: 'main.tex', search: 'Le chat dort.', replace: 'Le chat ronfle.' },
        { path: 'main.tex', search: 'Fin.', replace: 'Fin.\nÉpilogue.' },
        { path: 'annexe.tex', search: '', replace: 'Annexe.\n' },
      ],
      none,
      none,
      [],
    );
    const hunks = draft.hunks();
    expect(hunks.map((hunk) => hunk.id)).toEqual(['h1', 'h2', 'h3']);
    const own = hunks.filter((hunk) => hunk.path === 'main.tex');
    expect(own).toHaveLength(2);
    expect(own[0]).toMatchObject({
      fileId: MAIN_ID,
      original: 'Le chat dort.\n',
      replacement: 'Le chat ronfle.\n',
    });
    expect(own[0]?.before.endsWith('\\begin{document}\n')).toBe(true);
    expect(accept(main, own)).toBe(draft.texts().find((file) => file.path === 'main.tex')?.text);
    expect(hunks.find((hunk) => hunk.path === 'annexe.tex')).toMatchObject({
      fileId: null,
      original: '',
      replacement: 'Annexe.\n',
    });
  });

  it('forgets an edit undone later, and has nothing to submit then', () => {
    const draft = new Draft(texts);
    draft.edit([{ path: 'main.tex', search: 'Fin.', replace: 'Conclusion.' }], none, none, []);
    draft.edit([{ path: 'main.tex', search: 'Conclusion.', replace: 'Fin.' }], none, none, []);
    expect(draft.changedPaths()).toEqual([]);
    expect(draft.hunks()).toEqual([]);
  });

  it('applies the checks of a proposal, all edits or none', () => {
    const draft = new Draft(texts);
    expect(() =>
      draft.edit(
        [
          { path: 'main.tex', search: 'Fin.', replace: 'Fin \\cite{inventee}.' },
          { path: 'main.tex', search: 'Le chien', replace: 'Un chien' },
        ],
        none,
        none,
        [],
      ),
    ).toThrow(/Unknown citation key inventee/);
    expect(() =>
      draft.edit(
        [{ path: 'refs.bib', search: '', replace: '@book{b, title={B}}' }],
        none,
        none,
        [],
      ),
    ).toThrow(ToolError);
    expect(draft.changedPaths()).toEqual([]);
    // A reference fetched in the conversation may be added, then cited.
    const fetched = [{ key: 'knuth1984', bibtex: '@article{knuth1984, title={Literate}}' }];
    draft.edit(
      [{ path: 'refs.bib', search: '', replace: fetched[0]?.bibtex ?? '' }],
      none,
      none,
      fetched,
    );
    draft.edit(
      [{ path: 'main.tex', search: 'Fin.', replace: 'Fin \\cite{knuth1984}.' }],
      none,
      none,
      fetched,
    );
    expect(draft.changedPaths().sort()).toEqual(['main.tex', 'refs.bib']);
  });

  it('refuses edits once submitted', () => {
    const draft = new Draft(texts);
    draft.submitted = true;
    expect(() =>
      draft.edit([{ path: 'main.tex', search: 'Fin.', replace: 'Conclusion.' }], none, none, []),
    ).toThrow(/already submitted/);
  });
});

describe('diffHunks', () => {
  it('groups changed lines, insertions and deletions, and keeps unchanged ones out', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nB\nc\nd2\nd3\n';
    const hunks = diffHunks({ fileId: MAIN_ID, path: 'x.tex' }, before, after, 1);
    expect(hunks.map(({ original, replacement }) => ({ original, replacement }))).toEqual([
      { original: 'b\n', replacement: 'B\n' },
      { original: 'd\ne\n', replacement: 'd2\nd3\n' },
    ]);
    expect(accept(before, hunks)).toBe(after);
    const inserted = diffHunks({ fileId: MAIN_ID, path: 'x.tex' }, before, `${before}f\n`, 1);
    expect(inserted).toMatchObject([{ start: before.length, original: '', replacement: 'f\n' }]);
  });
});
