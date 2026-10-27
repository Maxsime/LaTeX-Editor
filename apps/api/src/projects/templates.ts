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

/** Built-in starting points; the first file is the main document. */
export const templates: Record<ProjectTemplate, TemplateFile[]> = {
  blank: [{ path: 'main.tex', content: blankMain }],
  article: [
    { path: 'main.tex', content: articleMain },
    { path: 'references.bib', content: articleBib },
  ],
};
