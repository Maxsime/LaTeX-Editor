import { type Diagnostic, MAX_DIAGNOSTICS, type WordCount } from '@galley/shared';

/** Most `.tex` files given to chktex at once; a larger project is linted in part. */
export const MAX_LINTED_FILES = 200;

/** Field separator of the machine-readable outputs asked of chktex and texcount. */
const SEPARATOR = '\t';
const CHKTEX_MARK = 'CHKTEX';
const TEXCOUNT_SUM = 'GALLEY-SUM';
const TEXCOUNT_SUB = 'GALLEY-SUB';

/**
 * Command line of chktex over the project's `.tex` files, one line per
 * warning in a format {@link parseChktex} reads. Paths start with `./` so that
 * a file named like an option stays a file.
 */
export function chktexArgv(files: readonly string[], disabled: readonly number[]): string[] {
  const format = [CHKTEX_MARK, '%f', '%l', '%n', '%m'].join(SEPARATOR) + '\n';
  return [
    'chktex',
    '-q',
    // Every file is listed: following \input would report included files twice.
    '-I0',
    '-f',
    format,
    ...disabled.map((rule) => `-n${String(rule)}`),
    '--',
    ...files.slice(0, MAX_LINTED_FILES).map((file) => `./${file}`),
  ];
}

/** The `.tex` files of a manifest, in a stable order. */
export function lintedFiles(paths: Iterable<string>): string[] {
  return [...paths].filter((path) => path.toLowerCase().endsWith('.tex')).sort();
}

/** Reads chktex's warnings; paths come back relative to the project root. */
export function parseChktex(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of output.split('\n')) {
    const [mark, file, row, rule, ...message] = line.split(SEPARATOR);
    if (mark !== CHKTEX_MARK || file === undefined || rule === undefined) continue;
    const lineNumber = Number(row);
    diagnostics.push({
      level: 'warning',
      source: 'chktex',
      file: file.replace(/^\.\//, ''),
      line: Number.isInteger(lineNumber) && lineNumber > 0 ? lineNumber : null,
      message: message.join(SEPARATOR).trim(),
      // The rule number, for "turn this warning off".
      context: rule,
    });
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
  }
  return diagnostics;
}

/** Command line of texcount on the main file, includes merged, counted by section. */
export function texcountArgv(base: string): string[] {
  const fields = ['{1}', '{2}', '{3}'].join(SEPARATOR);
  const template =
    `${TEXCOUNT_SUM}${SEPARATOR}${fields}\\n` +
    `{SUB?${TEXCOUNT_SUB}${SEPARATOR}${fields}${SEPARATOR}{TITLE}\\n?SUB}`;
  return ['texcount', '-merge', '-sub=section', '-utf8', `-template=${template}`, `./${base}`];
}

/**
 * Cleans a texcount section title: it prints the source after the heading
 * command, up to the end of the line (`Section: Intro}\label{s}`).
 */
export function cleanTitle(raw: string): string {
  const title = raw.replace(/^[A-Za-z*]+:\s*/, '');
  let depth = 0;
  for (let index = 0; index < title.length; index += 1) {
    const char = title[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      if (depth === 0) return title.slice(0, index).trim();
      depth -= 1;
    }
  }
  return title.trim();
}

/** Reads the output of {@link texcountArgv}, or null when texcount counted nothing. */
export function parseTexcount(output: string): WordCount | null {
  let count: WordCount | null = null;
  const sections: WordCount['sections'] = [];
  for (const line of output.split('\n')) {
    const [mark, text, headers, captions, ...title] = line.split(SEPARATOR);
    const tally = { text: Number(text), headers: Number(headers), captions: Number(captions) };
    if (![tally.text, tally.headers, tally.captions].every(Number.isFinite)) continue;
    if (mark === TEXCOUNT_SUM) count = { total: tally, sections };
    else if (mark === TEXCOUNT_SUB)
      sections.push({ title: cleanTitle(title.join(SEPARATOR)), ...tally });
  }
  return count;
}
