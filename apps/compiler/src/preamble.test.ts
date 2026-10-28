import { describe, expect, it } from 'vitest';
import { formatArgv, preambleFingerprint, preambleOf, usesPreambleFormat } from './preamble.js';

const job = {
  mainFile: 'thesis/main.tex',
  manifest: {
    'thesis/main.tex': 'a'.repeat(64),
    'thesis/chapter.tex': 'b'.repeat(64),
    'thesis/macros.tex': 'c'.repeat(64),
    'style/house.sty': 'd'.repeat(64),
    'figures/plot.pdf': 'e'.repeat(64),
  },
  texmfManifest: {},
};
const PREAMBLE = '\\documentclass{report}\n\\usepackage{house}\n\\input{macros}\n';

describe('preambleOf', () => {
  it('stops at \\begin{document} and leaves comments out', () => {
    expect(
      preambleOf('\\documentclass{article} % class\n\\usepackage{x}\n\\begin{document}\nBody'),
    ).toBe('\\documentclass{article} \n\\usepackage{x}\n');
    expect(preambleOf('50\\% \\begin{document}')).toBe('50\\% ');
  });

  it('ignores a \\begin{document} in a comment, and a file without one', () => {
    expect(preambleOf('% \\begin{document}\n\\chapter{Two}\n')).toBeNull();
  });
});

describe('preambleFingerprint', () => {
  const base = preambleFingerprint(PREAMBLE, job, 'restricted', 'TeX Live 2026');

  it('changes with the preamble, the files it loads and the options', () => {
    expect(
      preambleFingerprint(`${PREAMBLE}\\usepackage{tikz}`, job, 'restricted', 'TeX Live 2026'),
    ).not.toBe(base);
    expect(preambleFingerprint(PREAMBLE, job, 'disabled', 'TeX Live 2026')).not.toBe(base);
    expect(preambleFingerprint(PREAMBLE, job, 'restricted', 'TeX Live 2027')).not.toBe(base);
    const changed = (path: string) =>
      preambleFingerprint(
        PREAMBLE,
        { ...job, manifest: { ...job.manifest, [path]: 'f'.repeat(64) } },
        'restricted',
        'TeX Live 2026',
      );
    expect(changed('thesis/macros.tex')).not.toBe(base);
    expect(changed('style/house.sty')).not.toBe(base);
    expect(
      preambleFingerprint(
        PREAMBLE,
        { ...job, texmfManifest: { 'x.sty': 'f'.repeat(64) } },
        'restricted',
        'TeX Live 2026',
      ),
    ).not.toBe(base);
  });

  it('ignores the body: the main file, chapters and figures', () => {
    for (const path of ['thesis/main.tex', 'thesis/chapter.tex', 'figures/plot.pdf']) {
      expect(
        preambleFingerprint(
          PREAMBLE,
          { ...job, manifest: { ...job.manifest, [path]: 'f'.repeat(64) } },
          'restricted',
          'TeX Live 2026',
        ),
      ).toBe(base);
    }
  });
});

describe('formatArgv', () => {
  it('dumps the preamble of the main file with mylatexformat', () => {
    expect(formatArgv('main.tex', 'restricted', '/out')).toEqual([
      'pdftex',
      '-ini',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-output-directory=/out',
      '-jobname=galley-preamble',
      '&pdflatex',
      'mylatexformat.ltx',
      'main.tex',
    ]);
    expect(formatArgv('main.tex', 'disabled', '/out')).toContain('-no-shell-escape');
    expect(formatArgv('main.tex', 'full', '/out')).toContain('-shell-escape');
  });
});

describe('usesPreambleFormat', () => {
  it('applies to pdfLaTeX only', () => {
    expect(usesPreambleFormat({ engine: 'pdflatex', precompilePreamble: true })).toBe(true);
    expect(usesPreambleFormat({ engine: 'xelatex', precompilePreamble: true })).toBe(false);
    expect(usesPreambleFormat({ engine: 'pdflatex', precompilePreamble: false })).toBe(false);
  });
});
