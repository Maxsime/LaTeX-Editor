import { describe, expect, it } from 'vitest';
import { previewDocument, previewPreamble } from './preview.js';

const MAIN = String.raw`\documentclass[12pt,twocolumn,french]{report}
\usepackage[T1]{fontenc}
\usepackage[margin=2cm]{geometry}
\usepackage{amsmath, hyperref,amsthm}
% \usepackage{commented}
\usepackage{tikz}
\usetikzlibrary{arrows.meta}
\tikzset{box/.style={draw, rounded corners}}
\newcommand{\R}{\mathbb{R}}
\newcommand\norm[1]{\left\lVert#1\right\rVert}
\renewcommand*{\vec}[1]{\boldsymbol{#1}}
\DeclareMathOperator{\Tr}{Tr}
\newtheorem{thm}{Théorème}[chapter]
\def\half#1{\frac{#1}{2}}
\let\epsilon\varepsilon
\makeatletter
\def\@pseudo{x}
\makeatother
\title{Thèse}
\author{Moi}
\pagestyle{fancy}
\begin{document}
\chapter{Un}
\end{document}
`;

describe('previewPreamble', () => {
  it('keeps packages, definitions and TikZ settings, in order', () => {
    const { className, classOptions, statements } = previewPreamble(
      MAIN.split('\\begin{document}')[0] ?? '',
    );
    expect(className).toBe('report');
    expect(classOptions).toEqual(['12pt', 'french']);
    expect(statements).toEqual([
      String.raw`\usepackage[T1]{fontenc}`,
      String.raw`\usepackage{amsmath,amsthm}`,
      String.raw`\usepackage{tikz}`,
      String.raw`\usetikzlibrary{arrows.meta}`,
      String.raw`\tikzset{box/.style={draw, rounded corners}}`,
      String.raw`\newcommand{\R}{\mathbb{R}}`,
      String.raw`\newcommand\norm[1]{\left\lVert#1\right\rVert}`,
      String.raw`\renewcommand*{\vec}[1]{\boldsymbol{#1}}`,
      String.raw`\DeclareMathOperator{\Tr}{Tr}`,
      String.raw`\newtheorem{thm}{Théorème}[chapter]`,
      String.raw`\def\half#1{\frac{#1}{2}}`,
      String.raw`\let\epsilon\varepsilon`,
      String.raw`\def\@pseudo{x}`,
    ]);
  });

  it('drops a package statement left empty, and stops at a blank line', () => {
    expect(previewPreamble('\\usepackage{hyperref,geometry}').statements).toEqual([]);
    expect(previewPreamble('\\newcommand{\\a}{A}\n\n{\\bfseries x}').statements).toEqual([
      '\\newcommand{\\a}{A}',
    ]);
  });
});

describe('previewDocument', () => {
  it('wraps the fragment in a standalone document with the preamble', () => {
    const document = previewDocument(MAIN, '$\\norm{x} \\in \\R$');
    expect(
      document.startsWith(
        '\\documentclass[varwidth=true,border=6pt,class=report,12pt,french]{standalone}\n\\makeatletter\n',
      ),
    ).toBe(true);
    expect(document).toContain(
      '\\makeatother\n\\begin{document}\n$\\norm{x} \\in \\R$\n\\end{document}\n',
    );
    expect(document).not.toContain('geometry');
    expect(document).not.toContain('\\title');
  });

  it('falls back to the standard math packages without a preamble', () => {
    expect(previewDocument('\\chapter{Deux}', 'x')).toContain('\\usepackage{amsmath,amssymb}');
  });
});
