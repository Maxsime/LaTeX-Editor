import type { ProjectTemplate } from '@galley/shared';

interface TemplateFile {
  path: string;
  content: string;
}

// An empty document produces no PDF, so a new project starts with a line of text.
const blankMain = String.raw`\documentclass{article}

\begin{document}

Hello, \LaTeX!

\end{document}
`;

const articleMain = String.raw`\documentclass[11pt,a4paper]{article}

\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{graphicx}
\usepackage{amsmath}
\usepackage[backend=biber]{biblatex}
\addbibresource{references.bib}

\title{Title}
\author{Author}
\date{\today}

\begin{document}

\maketitle

\begin{abstract}
Abstract.
\end{abstract}

\section{Introduction}

Text with a citation~\cite{knuth1984}.

\printbibliography

\end{document}
`;

const articleBib = `@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984},
}
`;

const reportMain = String.raw`\documentclass[11pt,a4paper]{report}

\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{graphicx}
\usepackage{amsmath}
\usepackage[hidelinks]{hyperref}

\title{Title}
\author{Author}
\date{\today}

\begin{document}

\maketitle
\tableofcontents

\include{chapters/introduction}

\end{document}
`;

const reportIntroduction = String.raw`\chapter{Introduction}
\label{chap:introduction}

Text.
`;

const beamerMain = String.raw`\documentclass{beamer}

\usepackage[T1]{fontenc}
\usetheme{Madrid}

\title{Title}
\author{Author}
\date{\today}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{Outline}
  \tableofcontents
\end{frame}

\section{First part}

\begin{frame}{First slide}
  \begin{itemize}
    \item First point
    \item Second point
  \end{itemize}
\end{frame}

\end{document}
`;

const letterMain = String.raw`\documentclass[11pt,a4paper]{letter}

\usepackage[T1]{fontenc}
\usepackage{lmodern}

\signature{Author}
\address{Street \\ City}

\begin{document}

\begin{letter}{Recipient \\ Street \\ City}

\opening{Dear Sir or Madam,}

Text.

\closing{Yours faithfully,}

\end{letter}

\end{document}
`;

/** Built-in starting points; the first file is the main document. */
export const templates: Record<ProjectTemplate, TemplateFile[]> = {
  blank: [{ path: 'main.tex', content: blankMain }],
  article: [
    { path: 'main.tex', content: articleMain },
    { path: 'references.bib', content: articleBib },
  ],
  report: [
    { path: 'main.tex', content: reportMain },
    { path: 'chapters/introduction.tex', content: reportIntroduction },
  ],
  beamer: [{ path: 'main.tex', content: beamerMain }],
  letter: [{ path: 'main.tex', content: letterMain }],
};
