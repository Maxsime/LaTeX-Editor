import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
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
};

function complete(text: string, explicit = false) {
  const state = EditorState.create({ doc: text });
  const context = new CompletionContext(state, text.length, explicit);
  return latexCompletionSource(() => sources)(context);
}

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
});
