import { describe, expect, it } from 'vitest';
import { extractKeyUses, type LintContext, lintDocument } from './lint.js';

const context = (labels: Record<string, number>, keys: string[] | null = null): LintContext => ({
  labelCounts: new Map(Object.entries(labels)),
  citationKeys: keys === null ? null : new Set(keys),
});

const codes = (text: string, ctx = context({})) =>
  lintDocument(text, ctx).map((issue) => `${issue.code}:${issue.name}`);

describe('extractKeyUses', () => {
  it('finds references and citations with the offsets of each key', () => {
    const text = 'See \\cref{a, b} and \\citep[p.~3]{knuth84,lamport}.';
    const uses = extractKeyUses(text);
    expect(uses.map((use) => [use.kind, use.key])).toEqual([
      ['reference', 'a'],
      ['reference', 'b'],
      ['citation', 'knuth84'],
      ['citation', 'lamport'],
    ]);
    for (const use of uses) expect(text.slice(use.from, use.to)).toBe(use.key);
  });

  it('reads every group of multi-cite commands and ignores comments', () => {
    const text = '\\textcites(see)[1]{a}[2]{b} % \\cite{hidden}\n\\nocite{*}';
    expect(extractKeyUses(text).map((use) => use.key)).toEqual(['a', 'b', '*']);
  });

  it('skips keys built from macros', () => {
    expect(extractKeyUses('\\ref{#1} \\cite{\\key}')).toEqual([]);
  });
});

describe('lintDocument', () => {
  it('accepts balanced environments', () => {
    expect(
      codes('\\begin{itemize}\\item a\\begin{enumerate}\\end{enumerate}\\end{itemize}'),
    ).toEqual([]);
  });

  it('reports a mismatched end as an error and an unclosed begin as a warning', () => {
    const issues = lintDocument('\\begin{a}\\begin{b}\\end{a}\n\\begin{c}', context({}));
    expect(issues.map((i) => [i.code, i.name, i.severity, i.expected])).toEqual([
      ['mismatchedEnvironment', 'a', 'error', 'b'],
      ['unclosedEnvironment', 'c', 'warning', undefined],
    ]);
  });

  it('reports the environments left open between a mismatched end and its begin', () => {
    expect(codes('\\begin{a}\\begin{b}\\begin{c}\\end{a}')).toEqual([
      'unclosedEnvironment:b',
      'mismatchedEnvironment:a',
    ]);
  });

  it('warns about an end opened elsewhere, but not inside definitions or verbatim', () => {
    expect(codes('\\end{document}')).toEqual(['unopenedEnvironment:document']);
    const definitions = [
      '\\newcommand{\\bc}{\\begin{center}}',
      '\\newcommand\\ec{\\end{center}}',
      '\\newenvironment{box}[1]{\\begin{minipage}{#1}}{\\end{minipage}}',
      '\\NewDocumentEnvironment{x}{m}{\\begin{quote}}{\\end{quote}}',
      '\\def\\q#1{\\begin{quote}#1}',
      '\\begin{verbatim}\\begin{nope}\\end{verbatim}',
    ];
    expect(codes(definitions.join('\n'))).toEqual([]);
  });

  it('checks labels and references against the project', () => {
    const text = '\\label{dup}\\label{once}\\ref{once}\\eqref{missing}';
    expect(codes(text, context({ dup: 2, once: 1 }))).toEqual([
      'duplicateLabel:dup',
      'unknownReference:missing',
    ]);
  });

  it('checks citations only when the project has a bibliography', () => {
    const text = '\\cite{known,unknown}\\nocite{*}';
    expect(codes(text)).toEqual([]);
    expect(codes(text, context({}, ['known']))).toEqual(['unknownCitation:unknown']);
  });

  it('locates issues on the key or the environment', () => {
    const text = 'x \\ref{nope} \\begin{a}';
    const [reference, environment] = lintDocument(text, context({}));
    expect(text.slice(reference?.from, reference?.to)).toBe('nope');
    expect(text.slice(environment?.from, environment?.to)).toBe('\\begin{a}');
  });
});
