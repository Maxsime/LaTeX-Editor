import type { LogEntry } from '@galley/latex-log';
import { MAX_DIAGNOSTICS } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import { locateRunaway, pagesFromLog, rankDiagnostics } from './compile.js';

const entry = (level: LogEntry['level'], message: string): LogEntry => ({
  level,
  source: 'tex',
  file: 'main.tex',
  line: 1,
  message,
  context: '',
  raw: message,
});

describe('pagesFromLog', () => {
  it('reads the last page count, or null without output', () => {
    expect(
      pagesFromLog(
        'Output written on /out/a.pdf (2 pages, 10 bytes).\nOutput written on /out/a.pdf (3 pages, 12 bytes).',
      ),
    ).toBe(3);
    expect(pagesFromLog('Output written on a.pdf (1 page, 5 bytes).')).toBe(1);
    expect(pagesFromLog('No pages of output.')).toBeNull();
  });
});

describe('rankDiagnostics', () => {
  it('puts errors first, removes duplicates and keeps the external file', () => {
    const external: LogEntry = {
      ...entry('error', 'in a package'),
      file: null,
      externalFile: '/usr/x.sty',
    };
    const { diagnostics, truncated } = rankDiagnostics([
      entry('badbox', 'box'),
      entry('warning', 'warn'),
      entry('error', 'err'),
      entry('error', 'err'),
      external,
    ]);
    expect(diagnostics.map((d) => d.message)).toEqual(['err', 'in a package', 'warn', 'box']);
    expect(diagnostics[1]).toMatchObject({ file: null, externalFile: '/usr/x.sty' });
    expect(diagnostics[0]).not.toHaveProperty('raw');
    expect(truncated).toBe(false);
  });

  it('cuts a flood of bad boxes', () => {
    const flood = Array.from({ length: MAX_DIAGNOSTICS + 10 }, (_, index) =>
      entry('badbox', `box ${String(index)}`),
    );
    const { diagnostics, truncated } = rankDiagnostics([...flood, entry('error', 'kept')]);
    expect(diagnostics).toHaveLength(MAX_DIAGNOSTICS);
    expect(diagnostics[0]?.message).toBe('kept');
    expect(truncated).toBe(true);
  });
});

describe('locateRunaway', () => {
  const source = [
    '\\documentclass{article}',
    '\\begin{document}',
    'Texte avant.',
    '\\textbf{texte en gras sans  accolade',
    '\\end{document}',
  ].join('\n');

  it('finds the line where the runaway argument starts', () => {
    expect(locateRunaway(source, '{texte en gras sans accolade \\end {document}')).toBe(4);
  });

  it('gives up on short or unknown text', () => {
    expect(locateRunaway(source, '{ab}')).toBeNull();
    expect(locateRunaway(source, '{nothing like this here}')).toBeNull();
  });
});
