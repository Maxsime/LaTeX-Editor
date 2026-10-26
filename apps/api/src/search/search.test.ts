import { ApiError } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import { compileQuery, expandTemplate, replaceInText, searchFiles } from './search.js';

const options = { q: '', regex: false, caseSensitive: false, wholeWord: false };

describe('searchFiles', () => {
  it('reports positions and previews', () => {
    const result = searchFiles(
      [
        { id: 'b', path: 'b.tex', text: 'x\n  \\cite{Knuth} and knuth' },
        { id: 'a', path: 'a.tex', text: 'KNUTH' },
      ],
      { ...options, q: 'knuth' },
    );
    expect(result.truncated).toBe(false);
    expect(
      result.matches.map(({ path, line, column, length }) => [path, line, column, length]),
    ).toEqual([
      ['a.tex', 1, 0, 5],
      ['b.tex', 2, 8, 5],
      ['b.tex', 2, 19, 5],
    ]);
    expect(result.matches[1]).toMatchObject({
      preview: '  \\cite{Knuth} and knuth',
      previewOffset: 8,
    });
  });

  it('treats literal queries literally and skips empty matches', () => {
    const files = [{ id: 'a', path: 'a.tex', text: 'a.b axb' }];
    expect(searchFiles(files, { ...options, q: 'a.b' }).matches).toHaveLength(1);
    expect(searchFiles(files, { ...options, q: 'a.b', regex: true }).matches).toHaveLength(2);
    expect(searchFiles(files, { ...options, q: 'z*', regex: true }).matches).toHaveLength(0);
  });

  it('truncates long result lists', () => {
    const result = searchFiles([{ id: 'a', path: 'a.tex', text: 'x'.repeat(1500) }], {
      ...options,
      q: 'x',
    });
    expect(result.matches).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it('shortens long lines around the match', () => {
    const text = `${'a'.repeat(300)}needle${'b'.repeat(300)}`;
    const [match] = searchFiles([{ id: 'a', path: 'a.tex', text }], {
      ...options,
      q: 'needle',
    }).matches;
    expect(match?.preview).toBe(`${'a'.repeat(80)}needle${'b'.repeat(80)}`);
    expect(match?.previewOffset).toBe(80);
  });

  it('runs hostile patterns in linear time and rejects invalid ones', () => {
    const started = performance.now();
    searchFiles([{ id: 'a', path: 'a.tex', text: `${'a'.repeat(5000)}!` }], {
      ...options,
      q: '(a+)+$',
      regex: true,
    });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(() => compileQuery({ ...options, q: '(', regex: true })).toThrow(ApiError);
    // Backreferences are not part of RE2.
    expect(() => compileQuery({ ...options, q: '(a)\\1', regex: true })).toThrow(ApiError);
  });
});

describe('replaceInText', () => {
  it('replaces literally or with groups, and counts', () => {
    const literal = compileQuery({ ...options, q: '$x' });
    expect(replaceInText('$x and $X', literal, '$1', false)).toEqual({
      text: '$1 and $1',
      count: 2,
    });
    const regex = compileQuery({
      ...options,
      q: '(\\w+)@(\\w+)',
      regex: true,
      caseSensitive: true,
    });
    expect(replaceInText('a@b c@d', regex, '$2@$1 $$ $&', true)).toEqual({
      text: 'b@a $ a@b d@c $ c@d',
      count: 2,
    });
  });

  it('leaves the text alone without non-empty matches', () => {
    const pattern = compileQuery({ ...options, q: 'q*', regex: true });
    expect(replaceInText('abc', pattern, 'X', true)).toEqual({ text: 'abc', count: 0 });
    expect(replaceInText('aqqb', pattern, 'X', true)).toEqual({ text: 'aXb', count: 1 });
  });
});

describe('expandTemplate', () => {
  it('handles missing and two-digit groups', () => {
    expect(expandTemplate('$1$2$12$9', ['m', 'g1', undefined])).toBe('g1g12$9');
  });
});
