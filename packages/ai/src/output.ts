/** A fenced code block of a model's answer. */
export interface FencedBlock {
  language: string;
  code: string;
}

const FENCE = /^```[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

/** The fenced code blocks of a Markdown answer, in order. */
export function fencedBlocks(text: string): FencedBlock[] {
  return [...text.matchAll(FENCE)].map((match) => ({
    language: (match[1] ?? '').toLowerCase(),
    code: (match[2] ?? '').replace(/\n$/, ''),
  }));
}

/**
 * The replacement of an inline edit: the first code block, or the whole answer
 * when a model answered without one. Null for an empty answer.
 */
export function inlineReplacement(text: string): string | null {
  const [block] = fencedBlocks(text);
  const replacement = block === undefined ? text.trim() : block.code;
  return replacement === '' ? null : replacement;
}

/** Code generated for insertion, and the preamble lines it needs. */
export interface GeneratedCode {
  code: string;
  preamble: string;
}

const PREAMBLE_LINE = /^\s*\\(usepackage|usetikzlibrary|usepgfplotslibrary|pgfplotsset)\b.*$/;

/**
 * Splits a `generate` answer: the `latex-preamble` block, else the package
 * lines at the top of the code; the code is the last `latex` or `tex` block.
 */
export function generatedCode(text: string): GeneratedCode | null {
  const blocks = fencedBlocks(text);
  const preambleBlock = blocks.find((block) => block.language === 'latex-preamble');
  const codeBlock = blocks
    .filter((block) => block.language !== 'latex-preamble')
    .findLast((block) => ['latex', 'tex', ''].includes(block.language));
  if (codeBlock === undefined) return null;
  const lines = codeBlock.code.split('\n');
  const leading: string[] = [];
  while (lines.length > 0 && PREAMBLE_LINE.test(lines[0] ?? '')) leading.push(lines.shift() ?? '');
  const preamble = [preambleBlock?.code ?? '', ...leading].filter((line) => line !== '').join('\n');
  const code = lines.join('\n').trim();
  return code === '' ? null : { code, preamble };
}

/**
 * A `standalone` document around a fragment, for a compiled preview. A full
 * document (one with `\documentclass`) is kept as it is.
 */
export function standaloneDocument(code: string, preamble = ''): string {
  if (/\\documentclass\b/.test(code)) return code;
  return [
    '\\documentclass[varwidth=true,border=6pt]{standalone}',
    '\\usepackage[T1]{fontenc}',
    '\\usepackage{amsmath,amssymb}',
    '\\usepackage{graphicx}',
    preamble,
    '\\begin{document}',
    code,
    '\\end{document}',
    '',
  ].join('\n');
}
