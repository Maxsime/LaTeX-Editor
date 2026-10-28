import { describe, expect, it } from 'vitest';
import { visualMarks } from './visual.js';

describe('visualMarks', () => {
  it('finds headings, starred or not, with the span of their title', () => {
    const text = '\\section{Intro}\n\\subsection*{Suite}';
    expect(visualMarks(text)).toEqual([
      { kind: 'heading', level: 2, from: 0, to: 15, contentFrom: 9, contentTo: 14 },
      { kind: 'heading', level: 3, from: 16, to: 35, contentFrom: 29, contentTo: 34 },
    ]);
    expect(text.slice(9, 14)).toBe('Intro');
  });

  it('finds emphasis, nested braces included, and inside titles', () => {
    const text = '\\section{Le \\emph{vrai} titre} et \\textbf{gras {x}}';
    const marks = visualMarks(text);
    expect(marks.map((mark) => mark.kind)).toEqual(['heading', 'style', 'style']);
    const bold = marks[2];
    expect(bold?.kind === 'style' && text.slice(bold.contentFrom, bold.contentTo)).toBe('gras {x}');
  });

  it('finds formulas in every notation, without their labels', () => {
    const text =
      'Soit $a^2$ et \\(b\\), puis \\[c\\] et $$d$$.\n\\begin{equation}\\label{eq}e=mc^2\\end{equation}';
    expect(
      visualMarks(text).map((mark) => (mark.kind === 'math' ? [mark.tex, mark.display] : null)),
    ).toEqual([
      ['a^2', false],
      ['b', false],
      ['c', true],
      ['d', true],
      ['e=mc^2', true],
    ]);
  });

  it('turns \\item into a bullet, but not \\itemize', () => {
    const text = '\\begin{itemize}\n  \\item un\n  \\itemsep\n\\end{itemize}';
    expect(visualMarks(text)).toEqual([{ kind: 'item', from: 18, to: 23 }]);
  });

  it('skips comments, escaped dollars and unclosed groups', () => {
    expect(visualMarks('% \\section{Non}\nPrix : 5 \\$ et 6 \\$.')).toEqual([]);
    expect(visualMarks('\\emph{ouvert\n\nfin}')).toEqual([]);
    expect(visualMarks('Un $ seul')).toEqual([]);
  });
});
