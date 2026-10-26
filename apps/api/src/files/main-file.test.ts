import { describe, expect, it } from 'vitest';
import { detectMainFile } from './main-file.js';

const doc = '\\documentclass{report}\n\\begin{document}\\end{document}\n';

describe('detectMainFile', () => {
  it('returns null when no root file declares a class', () => {
    expect(detectMainFile([{ id: '1', name: 'chapter.tex', content: '\\section{A}' }])).toBeNull();
  });

  it('accepts any file name', () => {
    expect(
      detectMainFile([
        { id: '1', name: 'notes.tex', content: '\\section{A}' },
        { id: '2', name: 'Rapport_final.tex', content: doc },
      ]),
    ).toBe('2');
  });

  it('ignores a commented-out declaration', () => {
    expect(
      detectMainFile([{ id: '1', name: 'a.tex', content: '% \\documentclass{x}\n' }]),
    ).toBeNull();
  });

  it('accepts options and leading commands', () => {
    const content = '\\RequirePackage{fix-cm}\n  \\documentclass[11pt]{synthese}\n';
    expect(detectMainFile([{ id: '1', name: 'a.tex', content }])).toBe('1');
  });

  it('prefers a conventional name, then name order', () => {
    expect(
      detectMainFile([
        { id: '1', name: 'b.tex', content: doc },
        { id: '2', name: 'main.tex', content: doc },
      ]),
    ).toBe('2');
    expect(
      detectMainFile([
        { id: '1', name: 'b.tex', content: doc },
        { id: '2', name: 'a.tex', content: doc },
      ]),
    ).toBe('2');
  });

  it('ignores non-tex files', () => {
    expect(detectMainFile([{ id: '1', name: 'a.cls', content: doc }])).toBeNull();
  });
});
