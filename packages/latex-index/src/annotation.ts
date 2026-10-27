import { readGroup, scanCommands } from './scanner.js';

/**
 * A piece of LanguageTool's "annotated text": prose to check, or markup that
 * LanguageTool skips and reads as `interpretAs` when it judges the sentence
 * around it. The concatenation of every `text` and `markup` is the source, so
 * the offsets LanguageTool reports are offsets in the source.
 */
export type AnnotationSegment =
  { text: string } | { markup: string; interpretAs?: string | undefined };

/** Stand-in for a formula or an unknown macro: reads as a noun. */
const NOUN = 'X';
/** Stand-in for a reference: reads as a number. */
const NUMBER = '1';
/** Separates blocks that are not part of the same sentence. */
const BREAK = '\n\n';

/** Environments typeset as mathematics: checked as a single noun. */
const MATH_ENVIRONMENTS = new Set(
  [
    'equation',
    'align',
    'alignat',
    'flalign',
    'gather',
    'multline',
    'eqnarray',
    'displaymath',
    'math',
    'dmath',
    'dgroup',
  ].flatMap((name) => [name, `${name}*`]),
);

/** Environments whose content is not prose. */
const SKIPPED_ENVIRONMENTS = new Set([
  'verbatim',
  'verbatim*',
  'Verbatim',
  'Verbatim*',
  'BVerbatim',
  'LVerbatim',
  'lstlisting',
  'minted',
  'comment',
  'filecontents',
  'filecontents*',
  'tikzpicture',
  'pgfpicture',
  'circuitikz',
  'axis',
  'forest',
  'tikzcd',
  'luacode',
  'luacode*',
]);

/** Environments whose `&` and `\\` separate cells rather than words. */
const TABLE_ENVIRONMENTS = new Set([
  'tabular',
  'tabular*',
  'tabularx',
  'tabulary',
  'longtable',
  'tabu',
  'array',
  'supertabular',
  'xltabular',
  'tblr',
]);

/**
 * Arguments that follow `\begin{name}`: `o` optional, `m` mandatory markup,
 * `t` mandatory prose. Optional arguments are always read when present.
 */
const ENVIRONMENT_ARGUMENTS: Readonly<Record<string, string>> = {
  tabular: 'm',
  'tabular*': 'mm',
  tabularx: 'mm',
  tabulary: 'mm',
  longtable: 'm',
  xltabular: 'mm',
  array: 'm',
  tblr: 'm',
  minipage: 'm',
  multicols: 'm',
  'multicols*': 'm',
  wrapfigure: 'mm',
  wraptable: 'mm',
  subfigure: 'm',
  subtable: 'm',
  thebibliography: 'm',
  column: 'm',
  block: 't',
  alertblock: 't',
  exampleblock: 't',
  frame: 'tt',
  otherlanguage: 'm',
  'otherlanguage*': 'm',
  tcolorbox: '',
};

/** Commands whose arguments are prose; `m` marks an argument that is not. */
interface ProseCommand {
  args: string;
  /** Whether the command starts a block of its own (a heading, a caption). */
  block: boolean;
  /** Read in place of the command and its markup arguments, e.g. quotes. */
  open?: string;
  close?: string;
}

const PROSE_COMMANDS: Readonly<Record<string, ProseCommand>> = {
  ...Object.fromEntries(
    [
      'part',
      'chapter',
      'section',
      'subsection',
      'subsubsection',
      'paragraph',
      'subparagraph',
      'addchap',
      'addsec',
      'minisec',
      'caption',
      'subcaption',
      'title',
      'subtitle',
      'frametitle',
      'framesubtitle',
      'footnote',
      'footnotetext',
      'marginpar',
      'thanks',
      'abstract',
    ].map((name) => [name, { args: 't', block: true }]),
  ),
  ...Object.fromEntries(
    [
      'emph',
      'textbf',
      'textit',
      'textsl',
      'textsc',
      'textsf',
      'textrm',
      'textup',
      'textmd',
      'textnormal',
      'underline',
      'uline',
      'mbox',
      'fbox',
      'text',
      'alert',
      'structure',
      'textls',
      'hl',
      'sout',
    ].map((name) => [name, { args: 't', block: false }]),
  ),
  enquote: { args: 't', block: false, open: '"', close: '"' },
  foreignlanguage: { args: 'mt', block: false },
  textcolor: { args: 'mt', block: false },
  colorbox: { args: 'mt', block: false },
  fcolorbox: { args: 'mmt', block: false },
  href: { args: 'mt', block: false },
  hyperref: { args: 't', block: false },
  makebox: { args: 't', block: false },
  framebox: { args: 't', block: false },
  parbox: { args: 'mt', block: false },
  raisebox: { args: 'mt', block: false },
  only: { args: 't', block: false },
  uncover: { args: 't', block: false },
  visible: { args: 't', block: false },
};

/** Commands that stand for a word or a number in the sentence, with their reading. */
const READ_AS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      'ref',
      'eqref',
      'pageref',
      'autoref',
      'Autoref',
      'cref',
      'Cref',
      'crefrange',
      'Crefrange',
      'vref',
      'Vref',
      'labelcref',
      'nameref',
      'num',
      'SI',
      'qty',
      'numrange',
      'SIrange',
      'qtyrange',
      'citeyear',
      'citeyearpar',
      'citedate',
      'thepage',
    ].map((name) => [name, NUMBER]),
  ),
  ...Object.fromEntries(
    [
      'cite',
      'Cite',
      'citep',
      'Citep',
      'parencite',
      'Parencite',
      'autocite',
      'Autocite',
      'supercite',
      'smartcite',
      'Smartcite',
      'footcite',
      'footcitetext',
      'cites',
      'parencites',
      'autocites',
      'footcites',
    ].map((name) => [name, '[1]']),
  ),
  ...Object.fromEntries(
    [
      'citet',
      'Citet',
      'textcite',
      'Textcite',
      'textcites',
      'citeauthor',
      'Citeauthor',
      'citealt',
      'citealp',
      'citetitle',
      'fullcite',
      'url',
      'nolinkurl',
      'path',
      'email',
      'ensuremath',
      'si',
      'unit',
      'gls',
      'Gls',
      'GLS',
      'glspl',
      'Glspl',
      'glsentrytext',
      'acrshort',
      'acrlong',
      'acrfull',
      'ac',
      'Ac',
      'acp',
      'Acp',
      'acs',
      'acl',
      'Acl',
      'acf',
      'Acf',
      'texttt',
      'verb',
      'lstinline',
      'mintinline',
      'today',
    ].map((name) => [name, NOUN]),
  ),
  LaTeX: 'LaTeX',
  LaTeXe: 'LaTeX',
  TeX: 'TeX',
  BibTeX: 'BibTeX',
  XeLaTeX: 'XeLaTeX',
  LuaLaTeX: 'LuaLaTeX',
  ldots: '…',
  dots: '…',
  textellipsis: '…',
  textendash: '–',
  textemdash: '—',
  textquoteright: '’',
  textquoteleft: '‘',
  guillemotleft: '«',
  guillemotright: '»',
  og: '« ',
  fg: ' »',
  euro: '€',
  texteuro: '€',
  textdegree: '°',
  degree: '°',
  copyright: '©',
  textcopyright: '©',
  S: '§',
  P: '¶',
  quad: ' ',
  qquad: ' ',
  enspace: ' ',
  thinspace: ' ',
  space: ' ',
  newline: ' ',
  linebreak: ' ',
  nobreakspace: ' ',
  textbackslash: '\\',
};

/** Commands that leave nothing in the sentence (labels, spacing, fonts...). */
const SILENT = new Set([
  'label',
  'index',
  'glossary',
  'nocite',
  'centering',
  'raggedright',
  'raggedleft',
  'noindent',
  'indent',
  'hline',
  'cline',
  'toprule',
  'midrule',
  'bottomrule',
  'cmidrule',
  'addlinespace',
  'hfill',
  'hspace',
  'phantomsection',
  'protect',
  'relax',
  'nobreak',
  'xspace',
  'footnotemark',
  'bfseries',
  'itshape',
  'slshape',
  'scshape',
  'upshape',
  'mdseries',
  'rmfamily',
  'sffamily',
  'ttfamily',
  'normalfont',
  'em',
  'bf',
  'it',
  'sl',
  'sc',
  'rm',
  'sf',
  'tt',
  'tiny',
  'scriptsize',
  'footnotesize',
  'small',
  'normalsize',
  'large',
  'Large',
  'LARGE',
  'huge',
  'Huge',
  'color',
  'selectlanguage',
  'pause',
  'onslide',
  'includegraphics',
  'multicolumn',
  'multirow',
  'rowcolor',
  'cellcolor',
  'columncolor',
  'arraybackslash',
  'hypertarget',
  'hyperlink',
  'addcontentsline',
  'markboth',
  'markright',
  'setcounter',
  'addtocounter',
  'stepcounter',
  'refstepcounter',
  'setlength',
  'addtolength',
]);

/** Commands that separate blocks: what follows starts a new paragraph. */
const BLOCK = new Set([
  'par',
  'maketitle',
  'tableofcontents',
  'listoffigures',
  'listoftables',
  'printbibliography',
  'bibliography',
  'bibliographystyle',
  'printindex',
  'printglossary',
  'printglossaries',
  'printacronyms',
  'newpage',
  'clearpage',
  'cleardoublepage',
  'pagebreak',
  'vspace',
  'vskip',
  'smallskip',
  'medskip',
  'bigskip',
  'vfill',
  'appendix',
  'frontmatter',
  'mainmatter',
  'backmatter',
  'input',
  'include',
  'subfile',
  'import',
  'subimport',
  'item',
  'bibitem',
  'titlepage',
  'author',
  'date',
  'institute',
  'and',
  'usepackage',
  'RequirePackage',
  'documentclass',
  'addbibresource',
  'graphicspath',
  'newcommand',
  'renewcommand',
  'providecommand',
  'newenvironment',
  'renewenvironment',
  'NewDocumentCommand',
  'RenewDocumentCommand',
  'ProvideDocumentCommand',
  'DeclareDocumentCommand',
  'NewDocumentEnvironment',
  'DeclareMathOperator',
  'newtheorem',
  'theoremstyle',
  'def',
  'gdef',
  'edef',
  'xdef',
  'let',
  'definecolor',
  'hypersetup',
  'geometry',
  'pagestyle',
  'thispagestyle',
  'captionsetup',
  'lstset',
  'tikzset',
  'pgfplotsset',
  'usetikzlibrary',
  'sisetup',
  'newacronym',
  'newglossaryentry',
  'makeglossaries',
  'makeindex',
  'hyphenation',
  'linespread',
  'setmainfont',
  'setsansfont',
  'setmonofont',
  'setmainlanguage',
  'setdefaultlanguage',
  'setotherlanguage',
  'usetheme',
  'usecolortheme',
  'usefonttheme',
  'useinnertheme',
  'useoutertheme',
  'setbeamertemplate',
  'setbeamercolor',
  'AtBeginSection',
  'AtBeginSubsection',
  'newcounter',
  'renewcounter',
  'numberwithin',
  'counterwithin',
  'DeclareFieldFormat',
  'ExecuteBibliographyOptions',
]);

/** Commands that define macros: their first argument may be a bare control sequence. */
const DEFINING = new Set([
  'newcommand',
  'renewcommand',
  'providecommand',
  'NewDocumentCommand',
  'RenewDocumentCommand',
  'ProvideDocumentCommand',
  'DeclareDocumentCommand',
  'DeclareMathOperator',
  'def',
  'gdef',
  'edef',
  'xdef',
  'let',
  'newlength',
  'newsavebox',
]);

/** Accent commands followed by one letter, as combining characters. */
const ACCENTS: Readonly<Record<string, string>> = {
  "'": '́',
  '`': '̀',
  '^': '̂',
  '"': '̈',
  '~': '̃',
  '=': '̄',
  '.': '̇',
  c: '̧',
  u: '̆',
  v: '̌',
  H: '̋',
  k: '̨',
  r: '̊',
};

/** Letters written as control words. */
const LETTERS: Readonly<Record<string, string>> = {
  oe: 'œ',
  OE: 'Œ',
  ae: 'æ',
  AE: 'Æ',
  o: 'ø',
  O: 'Ø',
  ss: 'ß',
  aa: 'å',
  AA: 'Å',
  l: 'ł',
  L: 'Ł',
  i: 'ı',
  j: 'ȷ',
};

/** Escaped characters and control symbols, with their reading. */
const SYMBOLS: Readonly<Record<string, string>> = {
  '%': '%',
  '&': '&',
  $: '$',
  '#': '#',
  _: '_',
  '{': '{',
  '}': '}',
  ',': ' ',
  ';': ' ',
  ':': ' ',
  '>': ' ',
  ' ': ' ',
  '\n': ' ',
  '!': '',
  '-': '',
  '/': '',
  '@': '',
};

function isLetter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z@]/.test(char);
}

class Builder {
  readonly segments: AnnotationSegment[] = [];

  text(value: string): void {
    if (value === '') return;
    const last = this.segments.at(-1);
    if (last !== undefined && 'text' in last) last.text += value;
    else this.segments.push({ text: value });
  }

  markup(value: string, interpretAs = ''): void {
    if (value === '') return;
    const last = this.segments.at(-1);
    const before = this.segments.at(-2);
    // Macros in a row, maybe on separate lines, read as one noun: `\\immediate\\write\\out`
    // must not read as a repeated word.
    if (
      interpretAs === NOUN &&
      last !== undefined &&
      'text' in last &&
      /^\s*$/.test(last.text) &&
      before !== undefined &&
      'markup' in before &&
      before.interpretAs?.endsWith(NOUN) === true
    ) {
      before.markup += last.text + value;
      this.segments.pop();
      return;
    }
    if (last !== undefined && 'markup' in last) {
      last.markup += value;
      if (interpretAs === NOUN && last.interpretAs?.endsWith(NOUN) === true) return;
      const joined = (last.interpretAs ?? '') + interpretAs;
      if (joined === '') delete last.interpretAs;
      else last.interpretAs = joined;
    } else {
      this.segments.push(interpretAs === '' ? { markup: value } : { markup: value, interpretAs });
    }
  }
}

/** Offset just after the end of the line containing `from` (its newline included). */
function lineEnd(source: string, from: number): number {
  const newline = source.indexOf('\n', from);
  return newline === -1 ? source.length : newline + 1;
}

/** Offset of the next unescaped `delimiter` at or after `from`, or -1. */
function findUnescaped(source: string, delimiter: string, from: number): number {
  let position = from;
  while (position < source.length) {
    if (source[position] === '\\') {
      position += 2;
      continue;
    }
    if (source.startsWith(delimiter, position)) return position;
    position += 1;
  }
  return -1;
}

class Converter {
  private readonly out = new Builder();
  /** Open environments, innermost last. */
  private readonly environments: string[] = [];

  constructor(private readonly source: string) {}

  run(): AnnotationSegment[] {
    const { source } = this;
    let from = 0;
    let to = source.length;
    // Only the body of a complete document is prose; the preamble is configuration.
    for (const token of scanCommands(source)) {
      if (token.name !== 'begin' && token.name !== 'end') continue;
      const group = readGroup(source, token.end);
      if (group?.content !== 'document') continue;
      if (token.name === 'begin' && from === 0) from = group.end;
      else if (token.name === 'end') {
        to = token.start;
        break;
      }
    }
    this.out.markup(source.slice(0, from), from === 0 ? '' : BREAK);
    this.prose(from, to);
    this.out.markup(source.slice(to), to === source.length ? '' : BREAK);
    return this.out.segments;
  }

  private get inTable(): boolean {
    return this.environments.some((name) => TABLE_ENVIRONMENTS.has(name));
  }

  /** Converts `[from, to)` as prose. */
  private prose(from: number, to: number): void {
    const { source, out } = this;
    let position = from;
    let textStart = from;
    const flush = (until: number) => {
      out.text(source.slice(textStart, until));
    };
    while (position < to) {
      const char = source[position];
      let next: number | null = null;
      if (char === '%') {
        flush(position);
        next = Math.min(lineEnd(source, position), to);
        out.markup(source.slice(position, next));
      } else if (char === '\\') {
        // A word glued to a macro that stands for a word (`pdf\LaTeX`) is one
        // technical term: it goes to markup with the macro, read as a whole.
        let start = position;
        if (this.readsAsWord(position)) {
          while (start > textStart && /\p{L}/u.test(source[start - 1] ?? '')) start -= 1;
        }
        flush(start);
        if (start < position) out.markup(source.slice(start, position));
        next = this.command(position, to);
      } else if (char === '$') {
        flush(position);
        const double = source[position + 1] === '$';
        const delimiter = double ? '$$' : '$';
        const close = findUnescaped(source, delimiter, position + delimiter.length);
        next = close === -1 || close >= to ? to : close + delimiter.length;
        out.markup(source.slice(position, next), NOUN);
      } else if (char === '~') {
        flush(position);
        next = position + 1;
        out.markup('~', ' ');
      } else if (char === '{' || char === '}') {
        flush(position);
        next = position + 1;
        out.markup(char);
      } else if (char === '&') {
        flush(position);
        next = position + 1;
        out.markup('&', this.inTable ? BREAK : ' ');
      } else if (
        (char === '`' && source[position + 1] === '`') ||
        source.startsWith("''", position)
      ) {
        flush(position);
        next = position + 2;
        out.markup(source.slice(position, next), '"');
      } else if (char === '-' && source[position + 1] === '-') {
        flush(position);
        const triple = source[position + 2] === '-';
        next = position + (triple ? 3 : 2);
        out.markup(source.slice(position, next), triple ? '—' : '–');
      }
      if (next === null) {
        position += 1;
      } else {
        position = Math.min(Math.max(next, position + 1), to);
        textStart = position;
      }
    }
    flush(to);
  }

  /** Whether the control word at `start` is read as a word (a name like `\\LaTeX`, or an unknown macro). */
  private readsAsWord(start: number): boolean {
    let end = start + 1;
    while (isLetter(this.source[end])) end += 1;
    if (end === start + 1) return false;
    const name = this.source.slice(start + 1, end);
    if (name in LETTERS || name in ACCENTS || name in PROSE_COMMANDS) return false;
    if (SILENT.has(name) || BLOCK.has(name) || name === 'begin' || name === 'end') return false;
    const reading = READ_AS[name];
    return reading === undefined || /^\p{L}+$/u.test(reading);
  }

  /** Handles the command at `start`, returns where prose resumes. */
  private command(start: number, to: number): number {
    const { source, out } = this;
    const first = source[start + 1];
    if (first === undefined) {
      out.markup('\\');
      return start + 1;
    }
    if (!isLetter(first)) return this.controlSymbol(start, first, to);

    let end = start + 1;
    while (end < to && isLetter(source[end])) end += 1;
    const name = source.slice(start + 1, end);

    if (name === 'begin' || name === 'end') return this.environment(start, end, name, to);
    if (name === 'verb' || name === 'lstinline' || name === 'mintinline') {
      return this.inlineVerbatim(start, end, name, to);
    }
    const letter = LETTERS[name];
    if (letter !== undefined) {
      // TeX swallows the spaces after a control word: `\oe uvre` is one word.
      let after = end;
      while (source[after] === ' ') after += 1;
      if (source.startsWith('{}', after)) after += 2;
      out.markup(source.slice(start, after), letter);
      return after;
    }
    const accent = ACCENTS[name];
    if (accent !== undefined) return this.accent(start, end, accent, to);

    const prose = PROSE_COMMANDS[name];
    if (prose !== undefined) return this.proseCommand(start, end, prose, to);

    let after = this.skipStarAndOverlay(end);
    if (DEFINING.has(name)) after = this.skipDefinition(after, to);
    after = this.skipArguments(after, to);
    const block = BLOCK.has(name);
    const reading = READ_AS[name] ?? (block || SILENT.has(name) ? '' : NOUN);
    out.markup(source.slice(start, after), block ? BREAK : reading);
    return after;
  }

  private controlSymbol(start: number, symbol: string, to: number): number {
    const { source, out } = this;
    if (symbol === '(' || symbol === '[') {
      const close = source.indexOf(symbol === '(' ? '\\)' : '\\]', start + 2);
      const end = close === -1 || close >= to ? to : close + 2;
      out.markup(source.slice(start, end), symbol === '(' ? NOUN : ` ${NOUN} `);
      return end;
    }
    if (symbol === '\\') {
      // `\\`, `\\*` and `\\[length]`: a line break, or the end of a table row.
      let end = start + 2;
      if (source[end] === '*') end += 1;
      const optional = source[end] === '[' ? readGroup(source, end, '[', ']') : null;
      if (optional !== null) end = optional.end;
      out.markup(source.slice(start, end), this.inTable ? BREAK : ' ');
      return end;
    }
    const accent = ACCENTS[symbol];
    if (accent !== undefined) return this.accent(start, start + 2, accent, to);
    const reading = SYMBOLS[symbol] ?? '';
    out.markup(source.slice(start, start + 2), reading);
    return start + 2;
  }

  /** `\'e`, `\'{e}`, `\c c`, `\c{c}`: the accented letter. */
  private accent(start: number, end: number, combining: string, to: number): number {
    const { source, out } = this;
    let position = end;
    while (isLetter(source[end - 1]) && source[position] === ' ') position += 1;
    let base: string | undefined;
    let after = position;
    if (source[position] === '{') {
      const group = readGroup(source, position);
      if (group !== null && group.end <= to) {
        base = group.content.replace(/^\\([ij])$/, '$1');
        after = group.end;
      }
    } else if (source[position] === '\\' && /[ij]/.test(source[position + 1] ?? '')) {
      base = source[position + 1];
      after = position + 2;
    } else if (/\p{L}/u.test(source[position] ?? '')) {
      base = source[position];
      after = position + 1;
    }
    if (base?.length !== 1) {
      out.markup(source.slice(start, end));
      return end;
    }
    out.markup(source.slice(start, after), (base + combining).normalize('NFC'));
    return after;
  }

  private inlineVerbatim(start: number, end: number, name: string, to: number): number {
    const { source, out } = this;
    let position = end;
    if (source[position] === '*') position += 1;
    if (source[position] === '[') {
      const optional = readGroup(source, position, '[', ']');
      if (optional !== null) position = optional.end;
    }
    if (name === 'mintinline') {
      const language = readGroup(source, position);
      if (language !== null) position = language.end;
    }
    const delimiter = source[position];
    let after = position;
    if (delimiter !== undefined && delimiter !== '\n') {
      const close = source.indexOf(delimiter === '{' ? '}' : delimiter, position + 1);
      after = close === -1 || close >= to ? lineEnd(source, position) : close + 1;
    }
    out.markup(source.slice(start, Math.min(after, to)), NOUN);
    return Math.min(after, to);
  }

  private skipStarAndOverlay(from: number): number {
    const { source } = this;
    let position = from;
    if (source[position] === '*') position += 1;
    // Beamer overlay specifications: \item<2->, \only<1>{...}.
    if (source[position] === '<') {
      const close = source.indexOf('>', position);
      const newline = source.indexOf('\n', position);
      if (close !== -1 && (newline === -1 || close < newline)) position = close + 1;
    }
    return position;
  }

  /** The defined name of `\newcommand\foo`, `\def\foo#1#2`, `\let\a=\b`. */
  private skipDefinition(from: number, to: number): number {
    const { source } = this;
    let position = from;
    while (source[position] === ' ') position += 1;
    if (source[position] !== '\\') return from;
    position += 1;
    while (position < to && isLetter(source[position])) position += 1;
    if (position === from + 1) position += 1;
    // Parameter text of \def, up to its body; = and the target of \let.
    while (position < to && /[#0-9=\s]/.test(source[position] ?? '')) {
      if (source[position] === '\n' && source[position + 1] === '\n') break;
      position += 1;
    }
    if (source[position] === '\\') {
      position += 1;
      while (position < to && isLetter(source[position])) position += 1;
    }
    return position;
  }

  /** Optional and mandatory arguments written right after a command. */
  private skipArguments(from: number, to: number): number {
    const { source } = this;
    let position = from;
    for (;;) {
      const char = source[position];
      if (char !== '{' && char !== '[' && char !== '(') return position;
      // Parenthesised arguments only for biblatex multi-cite pre- and post-notes.
      const close = char === '{' ? '}' : char === '[' ? ']' : ')';
      const group = readGroup(source, position, char, close);
      if (group === null || group.end > to) return position;
      position = group.end;
    }
  }

  private proseCommand(start: number, end: number, command: ProseCommand, to: number): number {
    const { source, out } = this;
    let position = this.skipStarAndOverlay(end);
    // Optional arguments (short titles, colour models) are markup.
    for (;;) {
      const optional = source[position] === '[' ? readGroup(source, position, '[', ']') : null;
      if (optional === null || optional.end > to) break;
      position = optional.end;
    }
    const opening = source.slice(start, position);
    const before = command.block ? BREAK : '';
    let pending = { from: start, reading: before + (command.open ?? '') };
    let read = false;
    for (const kind of command.args) {
      const group = readGroup(source, position);
      if (group === null || group.end > to) break;
      if (kind === 'm') {
        position = group.end;
        continue;
      }
      out.markup(source.slice(pending.from, group.start + 1), pending.reading);
      this.prose(group.start + 1, group.end - 1);
      pending = { from: group.end - 1, reading: '' };
      position = group.end;
      read = true;
    }
    if (!read) {
      // No argument, or one never closed: what follows is read as prose.
      out.markup(opening, before);
      return position;
    }
    out.markup(source.slice(pending.from, position), (command.close ?? '') + before);
    return position;
  }

  private environment(start: number, end: number, kind: 'begin' | 'end', to: number): number {
    const { source, out } = this;
    const group = readGroup(source, end);
    if (group === null || group.end > to) {
      out.markup(source.slice(start, end));
      return end;
    }
    const name = group.content.trim();
    if (kind === 'end') {
      const index = this.environments.lastIndexOf(name);
      if (index !== -1) this.environments.splice(index);
      out.markup(source.slice(start, group.end), BREAK);
      return group.end;
    }
    if (MATH_ENVIRONMENTS.has(name) || SKIPPED_ENVIRONMENTS.has(name)) {
      const closing = `\\end{${name}}`;
      const close = source.indexOf(closing, group.end);
      const after = close === -1 || close + closing.length > to ? to : close + closing.length;
      out.markup(source.slice(start, after), MATH_ENVIRONMENTS.has(name) ? ` ${NOUN} ` : BREAK);
      return after;
    }
    this.environments.push(name);
    let position = this.skipStarAndOverlay(group.end);
    const spec = ENVIRONMENT_ARGUMENTS[name] ?? '';
    let markupFrom = start;
    const skipOptional = () => {
      for (;;) {
        const optional = source[position] === '[' ? readGroup(source, position, '[', ']') : null;
        if (optional === null || optional.end > to) return;
        position = optional.end;
      }
    };
    skipOptional();
    for (const kind of spec) {
      const argument = source[position] === '{' ? readGroup(source, position) : null;
      if (argument === null || argument.end > to) break;
      if (kind === 't') {
        out.markup(source.slice(markupFrom, argument.start + 1), BREAK);
        this.prose(argument.start + 1, argument.end - 1);
        markupFrom = argument.end - 1;
      }
      position = argument.end;
      skipOptional();
    }
    out.markup(source.slice(markupFrom, position), BREAK);
    return position;
  }
}

/**
 * Converts a LaTeX source to LanguageTool's annotated text: prose is checked,
 * commands, formulas, comments and non-prose environments are skipped and
 * read as a neutral word, a number or a paragraph break, so that the sentence
 * around them stays grammatical. The preamble of a complete document is skipped.
 */
export function toAnnotation(source: string): AnnotationSegment[] {
  return new Converter(source).run();
}

/** A run of segments that LanguageTool can check on its own, and where it starts in the source. */
export interface AnnotationParagraph {
  offset: number;
  segments: AnnotationSegment[];
}

function rawOf(segment: AnnotationSegment): string {
  return 'text' in segment ? segment.text : segment.markup;
}

/**
 * Splits annotated text into paragraphs, at blank lines in prose and at
 * markup read as a paragraph break, so that an edit only re-checks its own
 * paragraph. Paragraphs made of markup alone are dropped.
 */
export function splitParagraphs(segments: readonly AnnotationSegment[]): AnnotationParagraph[] {
  const paragraphs: AnnotationParagraph[] = [];
  let current: AnnotationParagraph = { offset: 0, segments: [] };
  let offset = 0;
  const close = (at: number) => {
    if (current.segments.some((segment) => 'text' in segment && segment.text.trim() !== '')) {
      paragraphs.push(current);
    }
    current = { offset: at, segments: [] };
  };
  for (const segment of segments) {
    if ('markup' in segment) {
      current.segments.push(segment);
      offset += segment.markup.length;
      if (segment.interpretAs?.includes(BREAK) === true) close(offset);
      continue;
    }
    // Blank lines inside prose end a paragraph.
    const pattern = /\n[ \t]*\n\s*/g;
    let start = 0;
    for (const match of segment.text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      current.segments.push({ text: segment.text.slice(start, end) });
      close(offset + end);
      start = end;
    }
    if (start < segment.text.length) current.segments.push({ text: segment.text.slice(start) });
    offset += segment.text.length;
  }
  close(offset);
  return paragraphs;
}

/** Source text of segments, as LanguageTool counts offsets in it. */
export function annotationSource(segments: readonly AnnotationSegment[]): string {
  return segments.map(rawOf).join('');
}

/** Ranges of the source that are prose, for checking where a report falls. */
export function proseRanges(segments: readonly AnnotationSegment[]): [number, number][] {
  const ranges: [number, number][] = [];
  let offset = 0;
  for (const segment of segments) {
    const length = rawOf(segment).length;
    if ('text' in segment) ranges.push([offset, offset + length]);
    offset += length;
  }
  return ranges;
}
