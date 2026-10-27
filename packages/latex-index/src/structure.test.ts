import { describe, expect, it } from 'vitest';
import { LineIndex, readGroup, scanCommands } from './scanner.js';
import { extractStructure, plainTitle } from './structure.js';

describe('scanner', () => {
  it('skips comments, escapes and verbatim material', () => {
    const text = [
      '\\section{A} % \\section{commented}',
      '50\\% \\verb|\\section{inline}| \\lstinline{\\x}',
      '\\begin{verbatim}',
      '\\section{verbatim}',
      '\\end{verbatim}',
      '\\label{a}',
    ].join('\n');
    expect([...scanCommands(text)].map((token) => token.name)).toEqual([
      'section',
      'begin',
      'end',
      'label',
    ]);
  });

  it('tolerates unterminated verbatim', () => {
    expect([...scanCommands('\\verb|open\n\\label{x}')].map((token) => token.name)).toEqual([
      'label',
    ]);
    expect([...scanCommands('\\begin{comment}\n\\label{x}')].map((token) => token.name)).toEqual([
      'begin',
    ]);
    expect([...scanCommands('\\verb')]).toEqual([]);
  });

  it('reads nested and bracketed groups', () => {
    expect(readGroup('  {a{b}\\}c}', 0)?.content).toBe('a{b}\\}c');
    expect(readGroup('[x={]}]', 0, '[', ']')?.content).toBe('x={]}');
    expect(readGroup('{unclosed', 0)).toBeNull();
    expect(readGroup('x', 0)).toBeNull();
    expect(readGroup('{a % }\n}', 0)?.content).toBe('a % }\n');
  });

  it('maps offsets to lines', () => {
    const lines = new LineIndex('a\nbc\n\nd');
    expect([0, 1, 2, 4, 5, 6].map((offset) => lines.lineOf(offset))).toEqual([1, 1, 2, 2, 3, 4]);
  });
});

describe('extractStructure', () => {
  it('finds headings with their level, title and line', () => {
    const { headings } = extractStructure(
      [
        '\\part{One}',
        '\\chapter[Short]{Long \\emph{title}\\label{ch}}',
        '\\section*{Intro~text}',
        '\\subsection',
        '  {Split}',
        '\\paragraph{P}\\subparagraph{Q}',
        '\\subsubsection{50\\% done}',
      ].join('\n'),
    );
    expect(
      headings.map(({ level, title, starred, line }) => [level, title, starred, line]),
    ).toEqual([
      ['part', 'One', false, 1],
      ['chapter', 'Long title', false, 2],
      ['section', 'Intro text', true, 3],
      ['subsection', 'Split', false, 4],
      ['paragraph', 'P', false, 6],
      ['subparagraph', 'Q', false, 6],
      ['subsubsection', '50% done', false, 7],
    ]);
  });

  it('reads Beamer frame titles', () => {
    const { headings } = extractStructure(
      [
        '\\begin{frame}<2>[fragile]{Opening}',
        '\\end{frame}',
        '\\begin{frame}',
        '\\frametitle{Later}',
        '\\end{frame}',
        '\\begin{frame}',
        '\\end{frame}',
        '\\begin{itemize}\\end{itemize}',
      ].join('\n'),
    );
    expect(headings.map((heading) => heading.title)).toEqual(['Opening', 'Later', '']);
  });

  it('collects labels and definitions', () => {
    const structure = extractStructure(
      [
        '\\newcommand{\\R}{\\mathbb{R}}',
        '\\newcommand\\pair[2]{(#1,#2)}',
        '\\renewcommand{\\opt}[2][x]{#1#2}',
        '\\providecommand{\\bad name}{}',
        '\\DeclareMathOperator*{\\argmax}{arg\\,max}',
        '\\def\\twice#1#2{#1#1}',
        '\\NewDocumentCommand{\\doc}{O{d} m +m}{}',
        '\\newenvironment{boxed}[1]{}{}',
        '\\NewDocumentEnvironment{fancy}{m o}{}{}',
        '\\newtheorem{theorem}{Theorem}',
        '\\label{eq:one} \\label{ }',
      ].join('\n'),
    );
    expect(structure.commands.map(({ name, args, optional }) => [name, args, optional])).toEqual([
      ['R', 0, false],
      ['pair', 2, false],
      ['opt', 2, true],
      ['argmax', 0, false],
      ['twice', 2, false],
      ['doc', 3, true],
    ]);
    expect(structure.commands.map((command) => command.definition)).toEqual([
      '\\mathbb{R}',
      '(#1,#2)',
      undefined,
      '\\operatorname*{arg\\,max}',
      '#1#1',
      undefined,
    ]);
    expect(structure.environments.map(({ name, args }) => [name, args])).toEqual([
      ['boxed', 1],
      ['fancy', 2],
      ['theorem', 1],
    ]);
    expect(structure.labels).toEqual([{ name: 'eq:one', line: 11 }]);
  });

  it('collects file references', () => {
    const { includes } = extractStructure(
      [
        '\\input{chapters/one}',
        '\\include{two.tex}',
        '\\subfile{parts/three}',
        '\\import{sections/}{four}',
        '\\includegraphics[width=\\linewidth]{fig/plot.pdf}',
        '\\bibliography{refs, more}',
        '\\addbibresource{lib.bib}',
        '\\lstinputlisting[language=C]{code.c}',
        '\\input{}',
      ].join('\n'),
    );
    expect(includes.map(({ kind, path, directory }) => [kind, path, directory])).toEqual([
      ['input', 'chapters/one', undefined],
      ['include', 'two.tex', undefined],
      ['subfile', 'parts/three', undefined],
      ['import', 'four', 'sections/'],
      ['graphics', 'fig/plot.pdf', undefined],
      ['bibliography', 'refs', undefined],
      ['bibliography', 'more', undefined],
      ['bibliography', 'lib.bib', undefined],
      ['other', 'code.c', undefined],
    ]);
  });

  it('handles 5 000 lines quickly', () => {
    const chunk = '\\section{S}\\label{s}\nSome text with $x^2$ and \\cite{k}.\n% note\n';
    const text = chunk.repeat(1700);
    const started = performance.now();
    const { headings, labels } = extractStructure(text);
    expect(headings).toHaveLength(1700);
    expect(labels).toHaveLength(1700);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('plainTitle', () => {
  it('strips markup', () => {
    expect(plainTitle('\\textbf{Bold}\\\\ and \\& {x}')).toBe('Bold and & x');
  });

  it('collects bibitems and labels given as options', () => {
    const structure = extractStructure(
      [
        '\\begin{lstlisting}[caption=Code, label={lst:code}]',
        'x = 1',
        '\\end{lstlisting}',
        '\\lstinputlisting[label=lst:file]{a.py}',
        '\\begin{thebibliography}{9}',
        '\\bibitem[K84]{knuth84} D. Knuth.',
        '\\end{thebibliography}',
      ].join('\n'),
    );
    expect(structure.labels).toEqual([
      { name: 'lst:code', line: 1 },
      { name: 'lst:file', line: 4 },
    ]);
    expect(structure.bibitems).toEqual([{ name: 'knuth84', line: 6 }]);
  });
});
