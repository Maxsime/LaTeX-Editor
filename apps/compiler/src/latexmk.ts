import type { CompileJob } from '@galley/shared';
import { SANDBOX_OUT } from './sandbox.js';

const ENGINE_FLAG: Record<CompileJob['engine'], string> = {
  pdflatex: '-pdf',
  xelatex: '-xelatex',
  lualatex: '-lualatex',
};

/** Effective shell-escape mode, after the administrator's policy. */
export function effectiveShellEscape(
  requested: CompileJob['shellEscape'],
  allowFull: boolean,
): CompileJob['shellEscape'] {
  return requested === 'full' && !allowFull ? 'restricted' : requested;
}

/** Splits a project path into the directory TeX runs in and the file name it compiles. */
export function splitMainFile(mainFile: string): { cwd: string; base: string; jobname: string } {
  const slash = mainFile.lastIndexOf('/');
  const cwd = slash === -1 ? '' : mainFile.slice(0, slash);
  const base = slash === -1 ? mainFile : mainFile.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return { cwd, base, jobname: dot > 0 ? base.slice(0, dot) : base };
}

/**
 * Command line of latexmk for a job (SPEC §6.3). latexmk runs from the folder
 * of the main file, like a local compilation, and writes everything to the
 * output folder, where auxiliary files survive between compilations.
 */
export function latexmkArgv(
  job: Pick<CompileJob, 'engine' | 'draft' | 'haltOnError'>,
  shellEscape: CompileJob['shellEscape'],
  base: string,
): string[] {
  const argv = [
    'latexmk',
    // Galley's rules only add dependencies (glossaries); they are read after a project latexmkrc.
    '-r',
    '/galley/latexmkrc',
    ENGINE_FLAG[job.engine],
    '-interaction=nonstopmode',
    '-file-line-error',
    '-synctex=1',
    `-outdir=${SANDBOX_OUT}`,
  ];
  if (shellEscape === 'disabled') argv.push('-no-shell-escape');
  if (shellEscape === 'full') argv.push('-shell-escape');
  // Without -f, latexmk gives up at the first error and leaves no PDF to look at.
  argv.push(job.haltOnError ? '-halt-on-error' : '-f');
  if (job.draft) argv.push('-usepretex=\\PassOptionsToPackage{draft}{graphicx}');
  argv.push(base);
  return argv;
}
