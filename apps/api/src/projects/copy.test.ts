import { describe, expect, it } from 'vitest';
import { stateWithCopies } from './copy.js';

const source = {
  manifest: { 'main.tex': 'a', 'chapters/one.tex': 'b', 'chapters/fig/plot.pdf': 'c' },
  folders: ['chapters', 'chapters/fig', 'empty'],
  paths: new Map([
    ['main', 'main.tex'],
    ['chapters', 'chapters'],
    ['one', 'chapters/one.tex'],
    ['fig', 'chapters/fig'],
    ['empty', 'empty'],
  ]),
};
const target = { manifest: { 'main.tex': 'x' }, folders: ['parts'] };

describe('stateWithCopies', () => {
  it('copies a file into a folder', () => {
    const state = stateWithCopies(source, target, ['one'], 'parts');
    expect(state.manifest).toEqual({ 'main.tex': 'x', 'parts/one.tex': 'b' });
  });

  it('copies a folder with its structure, relative to its parent', () => {
    const state = stateWithCopies(source, target, ['fig'], '');
    expect(state.manifest).toEqual({ 'main.tex': 'x', 'fig/plot.pdf': 'c' });
    expect(state.folders).toEqual(['fig', 'parts']);
    const nested = stateWithCopies(source, target, ['chapters', 'empty'], 'parts');
    expect(nested.manifest['parts/chapters/fig/plot.pdf']).toBe('c');
    expect(nested.folders).toEqual([
      'parts',
      'parts/chapters',
      'parts/chapters/fig',
      'parts/empty',
    ]);
  });

  it('never replaces a file or a folder of the target', () => {
    expect(() => stateWithCopies(source, target, ['main'], '')).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    expect(() =>
      stateWithCopies(source, { manifest: {}, folders: ['chapters'] }, ['chapters'], ''),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('refuses ids that are not in the source', () => {
    expect(() => stateWithCopies(source, target, ['elsewhere'], '')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});
