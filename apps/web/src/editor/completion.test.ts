import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  citationDetail,
  commandTemplate,
  type CompletionSources,
  latexCompletionSource,
  relativeTo,
} from './completion.js';

const sources: CompletionSources = {
  commands: [
    { name: 'R', args: 0, optional: false },
    { name: 'pair', args: 2, optional: false },
  ],
  environments: ['boxed'],
  paths: ['main.tex', 'chapters/one.tex', 'fig/plot.png', 'refs.bib'],
  directory: 'chapters',
  labels: ['fig:plot', 'sec:intro'],
  citations: [
    { key: 'knuth84', title: 'The TeXbook', authors: ['Knuth, Donald E.'], year: '1984' },
    {
      key: 'lamport94',
      title: null,
      authors: ['Lamport, Leslie', 'Other, A.'],
      year: '1994',
    },
  ],
};

/** Completion with the cursor at `|` in `text`, or at its end. */
function complete(text: string, explicit = false) {
  const position = text.includes('|') ? text.indexOf('|') : text.length;
  const state = EditorState.create({ doc: text.replace('|', '') });
  const context = new CompletionContext(state, position, explicit);
  return latexCompletionSource(() => sources)(context);
}

const labelsOf = (result: ReturnType<typeof complete>) =>
  result?.options.map((option) => option.label) ?? [];

describe('latex completion', () => {
  it('offers project and built-in commands after a backslash', () => {
    const result = complete('x \\pa');
    expect(result?.from).toBe(2);
    const labels = result?.options.map((option) => option.label) ?? [];
    expect(labels).toContain('\\pair');
    expect(labels).toContain('\\paragraph');
    expect(labels).toContain('\\R');
    expect(complete('plain text')).toBeNull();
  });

  it('offers environments after \\begin{ and \\end{', () => {
    const begin = complete('\\begin{bo');
    expect(begin?.from).toBe(7);
    expect(begin?.options.map((option) => option.label)).toContain('boxed');
    expect(begin?.options.map((option) => option.label)).toContain('itemize');
    const end = complete('\\end{ite');
    expect(end?.options.find((option) => option.label === 'itemize')?.apply).toBe('itemize}');
  });

  it('offers file paths for inclusion commands', () => {
    const input = complete('\\input{ch');
    expect(input?.options.map((option) => [option.label, option.apply])).toEqual([
      ['main.tex', 'main'],
      ['chapters/one.tex', 'chapters/one'],
    ]);
    const graphics = complete('\\includegraphics[width=3cm]{');
    expect(graphics?.options.map((option) => option.label)).toEqual(['fig/plot.png']);
    expect(complete('\\addbibresource{')?.options.map((option) => option.label)).toEqual([
      'refs.bib',
    ]);
    const subfile = complete('\\subfile{');
    expect(subfile?.options.map((option) => option.label)).toEqual(['../main.tex', 'one.tex']);
    expect(complete('\\textbf{')).toBeNull();
  });

  it('builds snippet templates and relative paths', () => {
    expect(commandTemplate('frac', 2)).toBe('\\frac{#{}}{#{}}');
    expect(relativeTo('', 'a/b.tex')).toBe('a/b.tex');
    expect(relativeTo('a/b', 'a/c/d.tex')).toBe('../c/d.tex');
  });

  it('offers the labels of the project and of the edited text after \\ref{', () => {
    const result = complete('\\label{eq:local}\n see \\cref{sec:a, fi');
    expect(labelsOf(result)).toEqual(['eq:local', 'fig:plot', 'sec:intro']);
    // Only the key being typed is replaced.
    expect(result?.from).toBe('\\label{eq:local}\n see \\cref{sec:a, '.length);
    expect(labelsOf(complete('\\eqref{'))).toContain('sec:intro');
  });

  it('offers citation keys with authors and year after \\cite and its variants', () => {
    const result = complete('\\parencite[p.~3]{kn');
    expect(labelsOf(result)).toEqual(['knuth84', 'lamport94']);
    expect(result?.options[0]?.detail).toBe('Knuth (1984)');
    expect(result?.options[0]?.info).toBe('The TeXbook');
    expect(labelsOf(complete('\\cites(see)[1]{knuth84}[2]{'))).toContain('lamport94');
    expect(citationDetail({ key: 'k', title: null, authors: [], year: null })).toBeUndefined();
    expect(citationDetail({ key: 'k', title: null, authors: ['A, B', 'C, D'], year: '2001' })).toBe(
      'A et al. (2001)',
    );
  });

  it('offers package and class options from the name after the cursor', () => {
    const geometry = complete('\\usepackage[a4paper, mar|]{geometry}');
    expect(labelsOf(geometry)).toContain('margin=');
    expect(geometry?.from).toBe('\\usepackage[a4paper, '.length);
    expect(labelsOf(complete('\\documentclass[|]{report}'))).toContain('openright');
    expect(labelsOf(complete('\\usepackage[|]{unknownpkg}'))).toEqual([]);
    expect(labelsOf(complete('\\usepackage{hyp'))).toContain('hyperref');
    expect(labelsOf(complete('\\documentclass{'))).toContain('beamer');
  });
});
