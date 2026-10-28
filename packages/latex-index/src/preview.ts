/**
 * Isolated preview of a fragment (SPEC §3.3): the fragment is compiled alone,
 * in a `standalone` document that keeps what the project's preamble loads and
 * defines, so that its macros, theorems and TikZ styles render as in the PDF.
 */

/** Commands of a preamble that a fragment may depend on. */
const KEPT = new Set([
  'usepackage',
  'RequirePackage',
  'newcommand',
  'renewcommand',
  'providecommand',
  'DeclareRobustCommand',
  'NewDocumentCommand',
  'RenewDocumentCommand',
  'ProvideDocumentCommand',
  'DeclareDocumentCommand',
  'NewDocumentEnvironment',
  'RenewDocumentEnvironment',
  'DeclareMathOperator',
  'DeclarePairedDelimiter',
  'newenvironment',
  'renewenvironment',
  'newtheorem',
  'theoremstyle',
  'newcolumntype',
  'def',
  'gdef',
  'edef',
  'let',
  'usetikzlibrary',
  'usepgfplotslibrary',
  'tikzset',
  'pgfplotsset',
  'definecolor',
  'colorlet',
  'sisetup',
  'setmainfont',
  'setsansfont',
  'setmonofont',
  'setmathfont',
  'newfontfamily',
  'input',
]);

/**
 * Packages left out: page layout, headers, links and bibliographies mean
 * nothing for a fragment, and some need external programs.
 */
const SKIPPED_PACKAGES = new Set([
  'geometry',
  'fancyhdr',
  'hyperref',
  'bookmark',
  'biblatex',
  'titlesec',
  'tocloft',
  'subfiles',
  'standalone',
  'minted',
  'pythontex',
  'svg',
  'glossaries',
  'glossaries-extra',
  'makeidx',
  'imakeidx',
  'pdfpages',
  'lastpage',
  'background',
  'eso-pic',
]);

/** Class options that would change the shape of the cropped page. */
const SKIPPED_OPTIONS = new Set(['twocolumn', 'landscape', 'titlepage', 'twoside', 'onecolumn']);

/**
 * Classes with chapters, used under `standalone` so that counters such as
 * `chapter` exist for the definitions that name them.
 */
const CHAPTER_CLASSES = new Set(['report', 'book', 'scrreprt', 'scrbook', 'memoir']);

/** Longest fragment previewed; a page of LaTeX is far below. */
export const MAX_PREVIEW_FRAGMENT = 20_000;

/** Offset after the group opened at `open` by `{` or `[`, or -1 when unbalanced. */
function groupEnd(text: string, open: number): number {
  const close = text[open] === '{' ? '}' : ']';
  const opener = text[open];
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') index += 1;
    else if (char === opener) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** Offset after spaces and a single line break, but not a blank line. */
function skipSpace(text: string, from: number): number {
  let index = from;
  let breaks = 0;
  while (index < text.length && /\s/.test(text[index] ?? '')) {
    if (text[index] === '\n') breaks += 1;
    if (breaks > 1) return from;
    index += 1;
  }
  return index;
}

/** End of the statement started by `\name` at `start`: its star, names, parameters and groups. */
function statementEnd(text: string, name: string, after: number): number {
  let index = after;
  if (text[index] === '*') index += 1;
  if (name === 'let') {
    const match = /^\s*\\(?:[A-Za-z@]+|.)\s*=?\s*(?:\\[A-Za-z@]+|.)/.exec(text.slice(index));
    return match === null ? index : index + match[0].length;
  }
  // `\newcommand\foo`, `\def\foo#1#2`: the defined name and parameter text.
  const defined = /^\s*\\(?:[A-Za-z@]+|.)/.exec(text.slice(index));
  if (defined !== null) index += defined[0].length;
  if (name.endsWith('def')) index += /^[^{]*/.exec(text.slice(index))?.[0].length ?? 0;
  for (;;) {
    const next = skipSpace(text, index);
    if (text[next] !== '{' && text[next] !== '[') return index;
    const end = groupEnd(text, next);
    if (end === -1) return index;
    index = end;
  }
}

/** A `\usepackage` statement without the packages a fragment does not need, or null. */
function filterPackages(statement: string): string | null {
  const match = /^(\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*)\{([^}]*)\}(.*)$/s.exec(
    statement,
  );
  if (match === null) return statement;
  const names = (match[2] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '' && !SKIPPED_PACKAGES.has(name));
  return names.length === 0 ? null : `${match[1] ?? ''}{${names.join(',')}}${match[3] ?? ''}`;
}

/** Text without comments, keeping escaped percent signs. */
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(?<!\\)%.*$/, ''))
    .join('\n');
}

/**
 * What a fragment needs from a preamble: its class options, and the packages,
 * definitions and settings it holds, in their order.
 */
export function previewPreamble(preamble: string): {
  className: string | null;
  classOptions: string[];
  statements: string[];
} {
  const text = stripComments(preamble);
  const classMatch = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/.exec(text);
  const classOptions = (classMatch?.[1] ?? '')
    .split(',')
    .map((option) => option.trim())
    .filter((option) => option !== '' && !SKIPPED_OPTIONS.has(option));
  const statements: string[] = [];
  const command = /\\([A-Za-z]+)/g;
  for (let match = command.exec(text); match !== null; match = command.exec(text)) {
    const name = match[1] ?? '';
    if (!KEPT.has(name)) continue;
    const end = statementEnd(text, name, match.index + match[0].length);
    const statement = /package$/i.test(name)
      ? filterPackages(text.slice(match.index, end).trim())
      : text.slice(match.index, end).trim();
    if (statement !== null) statements.push(statement);
    command.lastIndex = end;
  }
  return { className: classMatch?.[2]?.trim() ?? null, classOptions, statements };
}

/**
 * A complete `standalone` document showing `fragment` with the preamble of
 * the project's main file. A main file without `\begin{document}` gives no
 * preamble: the fragment then compiles with the standard packages only.
 */
export function previewDocument(mainSource: string, fragment: string): string {
  const begin = stripComments(mainSource).indexOf('\\begin{document}');
  const { className, classOptions, statements } = previewPreamble(
    begin === -1 ? '' : stripComments(mainSource).slice(0, begin),
  );
  return [
    `\\documentclass[${[
      'varwidth=true',
      'border=6pt',
      ...(className !== null && CHAPTER_CLASSES.has(className) ? [`class=${className}`] : []),
      ...classOptions,
    ].join(',')}]{standalone}`,
    '\\makeatletter',
    ...(statements.length === 0 ? ['\\usepackage{amsmath,amssymb}'] : statements),
    '\\makeatother',
    '\\begin{document}',
    fragment,
    '\\end{document}',
    '',
  ].join('\n');
}
