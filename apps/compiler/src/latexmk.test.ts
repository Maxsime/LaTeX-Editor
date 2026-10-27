import { describe, expect, it } from 'vitest';
import { effectiveShellEscape, latexmkArgv, splitMainFile } from './latexmk.js';

describe('splitMainFile', () => {
  it('separates the directory, the file and the job name', () => {
    expect(splitMainFile('main.tex')).toEqual({ cwd: '', base: 'main.tex', jobname: 'main' });
    expect(splitMainFile('thesis/report.v2.tex')).toEqual({
      cwd: 'thesis',
      base: 'report.v2.tex',
      jobname: 'report.v2',
    });
    expect(splitMainFile('noext')).toEqual({ cwd: '', base: 'noext', jobname: 'noext' });
  });
});

describe('effectiveShellEscape', () => {
  it('downgrades full shell-escape unless the administrator allows it', () => {
    expect(effectiveShellEscape('full', false)).toBe('restricted');
    expect(effectiveShellEscape('full', true)).toBe('full');
    expect(effectiveShellEscape('disabled', false)).toBe('disabled');
  });
});

describe('latexmkArgv', () => {
  const job = { engine: 'pdflatex', draft: false, haltOnError: false } as const;

  it('compiles into the output folder, forcing through errors by default', () => {
    expect(latexmkArgv(job, 'restricted', 'main.tex')).toEqual([
      'latexmk',
      '-r',
      '/galley/latexmkrc',
      '-pdf',
      '-interaction=nonstopmode',
      '-file-line-error',
      '-synctex=1',
      '-outdir=/out',
      '-f',
      'main.tex',
    ]);
  });

  it('maps engines, shell-escape, draft and halt-on-error', () => {
    const argv = latexmkArgv(
      { engine: 'lualatex', draft: true, haltOnError: true },
      'disabled',
      'a.tex',
    );
    expect(argv).toContain('-lualatex');
    expect(argv).toContain('-no-shell-escape');
    expect(argv).toContain('-halt-on-error');
    expect(argv).not.toContain('-f');
    expect(argv).toContain('-usepretex=\\PassOptionsToPackage{draft}{graphicx}');
    expect(latexmkArgv({ ...job, engine: 'xelatex' }, 'full', 'a.tex')).toEqual(
      expect.arrayContaining(['-xelatex', '-shell-escape']),
    );
  });
});
