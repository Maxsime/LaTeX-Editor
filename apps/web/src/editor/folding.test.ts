import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { latexFoldRange } from './folding.js';

const doc = Text.of([
  '\\documentclass{article}', // 1
  '\\begin{document}', // 2
  '\\section{One}', // 3
  'text', // 4
  '\\begin{itemize}', // 5
  '  \\begin{itemize}', // 6
  '    \\item nested', // 7
  '  \\end{itemize}', // 8
  '\\end{itemize}', // 9
  '\\subsection{Sub} % \\section{not a heading}', // 10
  'more', // 11
  '', // 12
  '\\section{Two}', // 13
  '\\begin{equation} x \\end{equation}', // 14
  'last', // 15
  '\\end{document}', // 16
]);

const lines = (range: { from: number; to: number } | null) =>
  range === null ? null : [doc.lineAt(range.from).number, doc.lineAt(range.to).number];

describe('latexFoldRange', () => {
  it('folds environments up to the line before their end', () => {
    expect(lines(latexFoldRange(doc, 5))).toEqual([5, 8]);
    expect(lines(latexFoldRange(doc, 6))).toEqual([6, 7]);
    expect(lines(latexFoldRange(doc, 2))).toEqual([2, 15]);
  });

  it('folds sections up to the next heading of the same rank', () => {
    expect(lines(latexFoldRange(doc, 3))).toEqual([3, 11]);
    expect(lines(latexFoldRange(doc, 10))).toEqual([10, 11]);
    expect(lines(latexFoldRange(doc, 13))).toEqual([13, 15]);
  });

  it('ignores lines that open nothing', () => {
    expect(latexFoldRange(doc, 4)).toBeNull();
    expect(latexFoldRange(doc, 14)).toBeNull();
    expect(latexFoldRange(Text.of(['\\begin{a}', '\\end{a}']), 1)).toBeNull();
    expect(latexFoldRange(Text.of(['% \\begin{a}', 'x', '\\end{a}']), 1)).toBeNull();
    expect(latexFoldRange(Text.of(['\\begin{a}', 'unclosed']), 1)).toBeNull();
  });
});
