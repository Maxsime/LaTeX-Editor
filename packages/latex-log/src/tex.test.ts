import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTexLog, type TexLogOptions } from './tex.js';
import type { LogEntry } from './types.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
}

const sandbox = (mainFile: string): TexLogOptions => ({
  projectRoot: '/project',
  cwd: '',
  outDir: '/out',
  mainFile,
});

/** The fields a user sees, for compact snapshots. */
function summary(entries: LogEntry[]) {
  return entries.map(({ level, file, externalFile, line, message }) => ({
    level,
    file,
    ...(externalFile === undefined ? {} : { externalFile }),
    line,
    message,
  }));
}

describe('parseTexLog on the corpus logs', () => {
  it.each([
    ['02-report-main.log', 'main.tex'],
    ['04-natbib-main.log', 'main.tex'],
    ['06-beamer-main.log', 'main.tex'],
    ['09-minted-main.log', 'main.tex'],
    ['10-errors-missing-brace.log', 'missing-brace.tex'],
    ['10-errors-missing-file.log', 'missing-file.tex'],
    ['10-errors-undefined-command.log', 'undefined-command.tex'],
    ['10-errors-undefined-reference.log', 'undefined-reference.tex'],
    ['12-hot-report-main.log', 'main.tex'],
  ])('%s', (name, mainFile) => {
    expect(summary(parseTexLog(fixture(name), sandbox(mainFile)))).toMatchSnapshot();
  });

  it('blames an error in an included file on that file, with its excerpt', () => {
    const [error] = parseTexLog(
      fixture('10-errors-undefined-command.log'),
      sandbox('undefined-command.tex'),
    );
    expect(error).toMatchObject({
      level: 'error',
      file: 'chapters/body.tex',
      line: 3,
      message: 'Undefined control sequence.',
      context: 'l.3 Ici, \\commandeinconnue\n                          {} provoque une erreur.',
    });
  });

  it('keeps the runaway text of a missing brace and drops the abort messages', () => {
    const entries = parseTexLog(
      fixture('10-errors-missing-brace.log'),
      sandbox('missing-brace.tex'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      file: 'missing-brace.tex',
      line: null,
      message: 'File ended while scanning use of \\textbf .',
      runaway: '{texte en gras sans accolade fermante \\end {document}',
    });
  });

  it('lends the location of the emergency stop to a missing file error', () => {
    const entries = parseTexLog(fixture('10-errors-missing-file.log'), sandbox('missing-file.tex'));
    expect(summary(entries)).toEqual([
      {
        level: 'error',
        file: 'missing-file.tex',
        line: 3,
        message: "LaTeX Error: File `chapitre-absent.tex' not found.",
      },
    ]);
  });

  it('places warnings in the file open at the time', () => {
    const entries = parseTexLog(fixture('12-hot-report-main.log'), sandbox('main.tex'));
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        file: 'chapters/two.tex',
        line: 4,
        message: "Citation 'knuth1984' on page 22 undefined on input line 4.",
      }),
    );
    // Continuation lines of \MessageBreak are joined to their warning.
    expect(entries).toContainEqual(
      expect.objectContaining({
        message:
          "biblatex: 'babel/polyglossia' detected but 'csquotes' missing. Loading 'csquotes' recommended.",
      }),
    );
  });
});

describe('parseTexLog on synthetic logs', () => {
  const options = { ...sandbox('thesis/main.tex'), cwd: 'thesis' };

  it('resolves paths relative to the directory TeX ran in', () => {
    const log = [
      '(./main.tex (/usr/local/texlive/2026/texmf-dist/tex/latex/base/report.cls)',
      '(./parts/one.tex',
      'Overfull \\hbox (12.0pt too wide) in paragraph at lines 10--12',
      '[]\\T1/cmr/m/n/10 text with an unbalanced ( parenthesis',
      '',
      "LaTeX Warning: Reference `x' on page 2 undefined on input line 14.",
      ')',
      '! Undefined control sequence.',
      'l.20 \\oops',
      '           ',
      'help text',
      '',
      ')',
    ].join('\n');
    expect(summary(parseTexLog(log, options))).toEqual([
      {
        level: 'badbox',
        file: 'thesis/parts/one.tex',
        line: 10,
        message: 'Overfull \\hbox (12.0pt too wide) in paragraph at lines 10--12',
      },
      {
        level: 'warning',
        file: 'thesis/parts/one.tex',
        line: 14,
        message: "Reference `x' on page 2 undefined on input line 14.",
      },
      { level: 'error', file: 'thesis/main.tex', line: 20, message: 'Undefined control sequence.' },
    ]);
  });

  it('reports errors raised inside a package with the package file', () => {
    const log =
      '/usr/local/texlive/2026/texmf-dist/tex/latex/minted/minted.sty:42: Package minted Error: boom.';
    expect(summary(parseTexLog(log, options))).toEqual([
      {
        level: 'error',
        file: null,
        externalFile: '/usr/local/texlive/2026/texmf-dist/tex/latex/minted/minted.sty',
        line: 42,
        message: 'Package minted Error: boom.',
      },
    ]);
  });

  it('handles quoted file names with spaces and absolute project paths', () => {
    const log = [
      '("/project/thesis/my chapter.tex"',
      'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      "(hyperref)                removing `math shift' on input line 3.",
      ')',
    ].join('\n');
    expect(summary(parseTexLog(log, options))).toEqual([
      {
        level: 'warning',
        file: 'thesis/my chapter.tex',
        line: 3,
        message:
          "hyperref: Token not allowed in a PDF string (Unicode): removing `math shift' on input line 3.",
      },
    ]);
  });

  it('keeps abort messages when nothing else explains them, and reads pdfTeX warnings', () => {
    const log = [
      'pdfTeX warning (dest): name{x} has been referenced but does not exist, replaced by a fixed one',
      '! Emergency stop.',
      '<*> main.tex',
      '',
    ].join('\n');
    expect(summary(parseTexLog(log, options))).toEqual([
      {
        level: 'warning',
        file: 'thesis/main.tex',
        line: null,
        message: 'name{x} has been referenced but does not exist, replaced by a fixed one',
      },
      { level: 'error', file: 'thesis/main.tex', line: null, message: 'Emergency stop.' },
    ]);
  });

  it('reports an error in a generated file without blaming a source', () => {
    const log = ['/out/main.toc:3: Undefined control sequence.', 'l.3 \\bad', ''].join('\n');
    expect(summary(parseTexLog(log, options))).toEqual([
      { level: 'error', file: null, line: 3, message: 'Undefined control sequence.' },
    ]);
  });

  it('reads class warnings and bad boxes without a line', () => {
    const log = [
      '(./main.tex',
      'Class beamer Warning: Something about frames.',
      'Underfull \\vbox (badness 10000) has occurred while \\output is active []',
      '',
      ')',
    ].join('\n');
    expect(summary(parseTexLog(log, options))).toEqual([
      {
        level: 'warning',
        file: 'thesis/main.tex',
        line: null,
        message: 'beamer: Something about frames.',
      },
      {
        level: 'badbox',
        file: 'thesis/main.tex',
        line: null,
        message: 'Underfull \\vbox (badness 10000) has occurred while \\output is active []',
      },
    ]);
  });

  it('ignores messages about generated files and font warnings outside the project', () => {
    const log = [
      '(/out/main.aux',
      "LaTeX Font Warning: Font shape `T1/cmr/m/sc' undefined",
      "(Font)              using `T1/cmr/m/n' instead on input line 7.",
      ')',
    ].join('\n');
    expect(summary(parseTexLog(log, options))).toEqual([
      {
        level: 'warning',
        file: null,
        line: 7,
        message:
          "Font: Font shape `T1/cmr/m/sc' undefined using `T1/cmr/m/n' instead on input line 7.",
      },
    ]);
  });
});
