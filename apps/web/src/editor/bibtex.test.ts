import { StringStream } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { bibtex } from './bibtex.js';

function tokens(lines: string[]): [string, string | null][] {
  const state = bibtex.startState?.(2) ?? {
    inEntry: false,
    depth: 0,
    expectKey: false,
    inQuote: false,
  };
  const result: [string, string | null][] = [];
  for (const line of lines) {
    const stream = new StringStream(line, 2, 2);
    while (!stream.eol()) {
      const style = bibtex.token(stream, state);
      if (stream.current().trim() !== '') result.push([stream.current(), style]);
      stream.start = stream.pos;
    }
  }
  return result;
}

describe('bibtex mode', () => {
  it('styles entries, keys, fields and values', () => {
    expect(
      tokens([
        'note outside',
        '@article{knuth84,',
        '  title = {The {\\TeX}book},',
        '  year = 1984,',
        '  journal = "J" # x',
        '}',
      ]),
    ).toEqual([
      ['note outside', 'comment'],
      ['@article', 'keyword'],
      ['{', 'bracket'],
      ['knuth84', 'labelName'],
      [',', 'punctuation'],
      ['title', 'propertyName'],
      ['=', 'punctuation'],
      ['{The {\\TeX}book}', 'string'],
      [',', 'punctuation'],
      ['year', 'propertyName'],
      ['=', 'punctuation'],
      ['1984', 'number'],
      [',', 'punctuation'],
      ['journal', 'propertyName'],
      ['=', 'punctuation'],
      ['"J"', 'string'],
      ['#', 'punctuation'],
      ['x', 'variableName'],
      ['}', 'bracket'],
    ]);
  });

  it('carries multi-line values over', () => {
    expect(tokens(['@misc{k, note = {first', 'second}}'])).toContainEqual(['second}', 'string']);
  });
});
