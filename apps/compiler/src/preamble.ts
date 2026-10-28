import { createHash } from 'node:crypto';
import type { CompileJob } from '@galley/shared';

/**
 * Preamble precompilation (SPEC §3.3): the preamble of the main file is dumped
 * into a format with `mylatexformat`, and later runs load it instead of reading
 * the packages again. Only pdfLaTeX: XeTeX refuses to dump a format holding
 * system fonts, which every XeLaTeX preamble loads, and LuaTeX formats break
 * with `luaotfload`.
 */

/** Name of the format, and of its files in the output folder. */
export const PREAMBLE_FORMAT = 'galley-preamble';
/** Fingerprint of the preamble the format was built from, beside it in the output folder. */
export const PREAMBLE_STAMP = `${PREAMBLE_FORMAT}.stamp`;

/** Project files a preamble can load without naming them by path. */
const PREAMBLE_EXTENSIONS = ['.sty', '.cls', '.clo', '.def', '.cfg', '.fd', '.ldf'];

/** Whether a job asks for, and can use, a precompiled preamble. */
export function usesPreambleFormat(
  job: Pick<CompileJob, 'engine' | 'precompilePreamble'>,
): boolean {
  return job.precompilePreamble && job.engine === 'pdflatex';
}

/**
 * The preamble of a LaTeX source: everything before `\begin{document}`,
 * comments aside. Null when the file has no `\begin{document}` of its own,
 * as a subfile or a document built by an `\input` does.
 */
export function preambleOf(source: string): string | null {
  const lines: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const code = line.replace(/(?<!\\)%.*$/, '');
    const begin = code.indexOf('\\begin{document}');
    if (begin !== -1) {
      lines.push(code.slice(0, begin));
      return lines.join('\n');
    }
    lines.push(code);
  }
  return null;
}

/**
 * Fingerprint of everything a format depends on: the preamble, the engine
 * options, TeX Live, the texmf tree, the project's packages and classes, and
 * every project file whose name the preamble mentions (`\input{macros}`).
 */
export function preambleFingerprint(
  preamble: string,
  job: Pick<CompileJob, 'manifest' | 'texmfManifest' | 'mainFile'>,
  shellEscape: CompileJob['shellEscape'],
  texlive: string,
): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([preamble, shellEscape, texlive]));
  const loaded = (path: string) => {
    if (path === job.mainFile) return false;
    if (PREAMBLE_EXTENSIONS.some((extension) => path.endsWith(extension))) return true;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
    return stem !== '' && preamble.includes(stem);
  };
  const files = Object.entries(job.manifest)
    .filter(([path]) => loaded(path))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  hash.update(JSON.stringify(files));
  hash.update(
    JSON.stringify(Object.entries(job.texmfManifest).sort(([a], [b]) => (a < b ? -1 : 1))),
  );
  return hash.digest('hex');
}

/**
 * Command line building the format from the main file, run from its folder
 * like latexmk. The shell-escape mode is the compilation's own: the preamble
 * runs the same code either way.
 */
export function formatArgv(
  base: string,
  shellEscape: CompileJob['shellEscape'],
  outDir: string,
): string[] {
  const argv = [
    'pdftex',
    '-ini',
    '-interaction=nonstopmode',
    '-halt-on-error',
    `-output-directory=${outDir}`,
    `-jobname=${PREAMBLE_FORMAT}`,
  ];
  if (shellEscape === 'disabled') argv.push('-no-shell-escape');
  if (shellEscape === 'full') argv.push('-shell-escape');
  argv.push('&pdflatex', 'mylatexformat.ltx', base);
  return argv;
}
