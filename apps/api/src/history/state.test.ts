import { describe, expect, it } from 'vitest';
import { diffStates, stateDigest } from './state.js';

describe('stateDigest', () => {
  it('ignores the order of entries and tells states apart', () => {
    const a = stateDigest({ manifest: { 'a.tex': '1', 'b.tex': '2' }, folders: ['x', 'y'] });
    const b = stateDigest({ manifest: { 'b.tex': '2', 'a.tex': '1' }, folders: ['y', 'x'] });
    expect(a).toBe(b);
    expect(stateDigest({ manifest: { 'a.tex': '1' }, folders: [] })).not.toBe(a);
    // An empty folder is part of the state.
    expect(stateDigest({ manifest: {}, folders: ['x'] })).not.toBe(
      stateDigest({ manifest: {}, folders: [] }),
    );
  });
});

describe('diffStates', () => {
  it('lists written and removed files, and folders left empty, deepest first', () => {
    const changes = diffStates(
      {
        manifest: { 'main.tex': '1', 'old/a.tex': '2', 'keep/b.tex': '3', 'gone/deep/c.tex': '4' },
        folders: ['old', 'keep', 'gone', 'gone/deep', 'empty'],
      },
      {
        manifest: { 'main.tex': '9', 'keep/b.tex': '3', 'new/d.tex': '5' },
        folders: ['keep', 'new', 'empty'],
      },
    );
    expect(changes).toEqual({
      written: ['main.tex', 'new/d.tex'],
      removedFiles: ['gone/deep/c.tex', 'old/a.tex'],
      removedFolders: ['gone/deep', 'gone', 'old'],
    });
  });

  it('keeps a folder that only lost its listing but still holds files', () => {
    const changes = diffStates(
      { manifest: { 'a/b.tex': '1' }, folders: ['a'] },
      { manifest: { 'a/b.tex': '1' }, folders: [] },
    );
    expect(changes.removedFolders).toEqual([]);
  });
});
