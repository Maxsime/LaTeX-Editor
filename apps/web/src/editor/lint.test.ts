import { Text } from '@codemirror/state';
import type { Diagnostic } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import { toLintDiagnostics } from './lint.js';

const doc = Text.of(['\\documentclass{article}', '\\begin{document}', '\\foo', '\\end{document}']);
const diagnostic = (level: Diagnostic['level'], line: number | null): Diagnostic => ({
  level,
  source: 'tex',
  file: 'main.tex',
  line,
  message: 'message',
  context: '',
});

describe('toLintDiagnostics', () => {
  it('marks the whole line with a matching severity', () => {
    const [marker] = toLintDiagnostics(doc, [diagnostic('error', 3)]);
    expect(marker).toMatchObject({ from: doc.line(3).from, to: doc.line(3).to, severity: 'error' });
  });

  it('shows bad boxes as information and clamps lines past the end', () => {
    const markers = toLintDiagnostics(doc, [diagnostic('badbox', 99), diagnostic('warning', 0)]);
    expect(markers.map((m) => m.severity)).toEqual(['info', 'warning']);
    expect(markers[0]?.from).toBe(doc.line(4).from);
    expect(markers[1]?.from).toBe(0);
  });

  it('skips diagnostics without a line', () => {
    expect(toLintDiagnostics(doc, [diagnostic('error', null)])).toEqual([]);
  });
});
