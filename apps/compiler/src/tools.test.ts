import { describe, expect, it } from 'vitest';
import {
  chktexArgv,
  cleanTitle,
  lintedFiles,
  parseChktex,
  parseTexcount,
  texcountArgv,
} from './tools.js';

describe('chktex', () => {
  it('lists the .tex files, guarded against option-like names, and the disabled rules', () => {
    const files = lintedFiles(['main.tex', 'refs.bib', '-n1.tex', 'chapters/a.TEX']);
    expect(files).toEqual(['-n1.tex', 'chapters/a.TEX', 'main.tex']);
    const argv = chktexArgv(files, [1, 36]);
    expect(argv.slice(-6)).toEqual([
      '-n1',
      '-n36',
      '--',
      './-n1.tex',
      './chapters/a.TEX',
      './main.tex',
    ]);
  });

  it('reads its warnings as diagnostics', () => {
    const output = [
      'ChkTeX v1.7.9 - Copyright 1995-96 Jens T. Berger Thielemann.',
      "CHKTEX\t./chapters/intro.tex\t12\t2\tNon-breaking space (`~') should have been used.",
      'CHKTEX\t./main.tex\t3\t26\tYou ought to remove spaces in front of punctuation.',
      'noise',
    ].join('\n');
    expect(parseChktex(output)).toEqual([
      {
        level: 'warning',
        source: 'chktex',
        file: 'chapters/intro.tex',
        line: 12,
        message: "Non-breaking space (`~') should have been used.",
        context: '2',
      },
      expect.objectContaining({ file: 'main.tex', line: 3, context: '26' }),
    ]);
  });
});

describe('texcount', () => {
  it('asks for a template it can read back', () => {
    const argv = texcountArgv('main.tex');
    expect(argv.at(-1)).toBe('./main.tex');
    expect(argv.find((arg) => arg.startsWith('-template='))).toContain('{SUB?');
  });

  it('reads the totals and sections, with clean titles', () => {
    const output = [
      'Possible precedence problem between ! and pattern match (m//) at /usr/bin/texcount line 1430.',
      'GALLEY-SUM\t83\t3\t8',
      'GALLEY-SUB\t21\t1\t0\tChapter: Introduction}\\label{chap:intro',
      'GALLEY-SUB\t12\t1\t8\tSection: Les {\\em figures}}',
    ].join('\n');
    expect(parseTexcount(output)).toEqual({
      total: { text: 83, headers: 3, captions: 8 },
      sections: [
        { title: 'Introduction', text: 21, headers: 1, captions: 0 },
        { title: 'Les {\\em figures}', text: 12, headers: 1, captions: 8 },
      ],
    });
    expect(parseTexcount('texcount: error')).toBeNull();
    expect(cleanTitle('Subsection*: A {b} c')).toBe('A {b} c');
  });
});
