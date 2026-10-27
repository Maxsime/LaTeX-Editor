import { describe, expect, it } from 'vitest';
import { buildOutline, joinPath, resolveReference } from './outline.js';
import { buildProjectIndex, isLatexSource } from './project.js';

describe('paths', () => {
  it('joins and normalises, refusing escapes', () => {
    expect(joinPath('', 'a/./b')).toBe('a/b');
    expect(joinPath('a/b', '../c')).toBe('a/c');
    expect(joinPath('a', 'sub\\file')).toBe('a/sub/file');
    expect(joinPath('', '../x')).toBeNull();
    expect(joinPath('a', '/etc/passwd')).toBeNull();
    expect(joinPath('', 'C:/x')).toBeNull();
  });

  it('resolves with the default extension', () => {
    const files = new Set(['ch/one.tex', 'two', 'two.tex']);
    const exists = (path: string): boolean => files.has(path);
    expect(resolveReference(exists, '', 'ch/one')).toBe('ch/one.tex');
    expect(resolveReference(exists, '', 'two')).toBe('two');
    expect(resolveReference(exists, '', '"ch/one"')).toBe('ch/one.tex');
    expect(resolveReference(exists, '', 'missing')).toBeNull();
    expect(resolveReference(exists, '', '.')).toBeNull();
  });
});

describe('buildOutline', () => {
  it('follows inclusions in document order and stops on cycles', () => {
    const files = new Map([
      [
        'thesis/main.tex',
        '\\chapter{Intro}\n\\input{chapters/a}\n\\section{After}\n\\include{missing}\n\\subfile{parts/c}',
      ],
      ['thesis/chapters/a.tex', '\\section{A}\n\\input{chapters/a}\n\\import{deep/}{d}'],
      ['thesis/chapters/deep/d.tex', '\\subsection{D}'],
      ['thesis/parts/c.tex', '\\section{C}\n\\subfile{../chapters/a}'],
    ]);
    const outline = buildOutline(files, 'thesis/main.tex');
    expect(outline.map(({ path, title, depth, line }) => [path, title, depth, line])).toEqual([
      ['thesis/main.tex', 'Intro', 1, 1],
      ['thesis/chapters/a.tex', 'A', 2, 1],
      ['thesis/chapters/deep/d.tex', 'D', 3, 1],
      ['thesis/main.tex', 'After', 2, 3],
      ['thesis/parts/c.tex', 'C', 2, 1],
    ]);
  });

  it('returns nothing for a missing main file', () => {
    expect(buildOutline(new Map(), 'main.tex')).toEqual([]);
  });
});

describe('buildProjectIndex', () => {
  it('collects definitions from LaTeX sources only, first definition wins', () => {
    const index = buildProjectIndex(
      new Map([
        ['b.tex', '\\newcommand{\\R}{x}\\newenvironment{env}{}{}\\label{b}'],
        ['a.sty', '\\newcommand{\\R}[1]{y}\\newenvironment{env}[2]{}{}'],
        ['notes.txt', '\\newcommand{\\ignored}{}'],
      ]),
    );
    expect(index.commands).toEqual([
      { name: 'R', args: 1, optional: false, line: 1, path: 'a.sty', definition: 'y' },
    ]);
    expect(index.environments).toEqual([{ name: 'env', args: 2, line: 1, path: 'a.sty' }]);
    expect(index.labels).toEqual([{ name: 'b', line: 1, path: 'b.tex' }]);
    expect(isLatexSource('Main.TEX')).toBe(true);
  });
});
