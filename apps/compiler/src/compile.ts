import { join } from 'node:path';
import { parseBibtexLog, parseBiberLog, parseTexLog, type LogEntry } from '@galley/latex-log';
import {
  type CompileJob,
  type CompileOutcome,
  type CompileResult,
  type Diagnostic,
  MAX_DIAGNOSTICS,
} from '@galley/shared';
import { effectiveShellEscape, latexmkArgv, splitMainFile } from './latexmk.js';
import {
  runSandboxed,
  SANDBOX_OUT,
  SANDBOX_PROJECT,
  type SandboxLimits,
  type SandboxRun,
} from './sandbox.js';
import {
  type BlobFetcher,
  cleanOutputs,
  listOutputs,
  type OutputFile,
  projectDirs,
  type ProjectDirs,
  readSandboxFile,
  syncSources,
} from './workdir.js';

/** Everything a compilation needs besides the job. */
export interface CompileEnvironment {
  workRoot: string;
  texliveDir: string;
  assetsDir: string;
  texmfDir: string;
  limits: SandboxLimits;
  allowFullShellEscape: boolean;
  /** TeX Live release, e.g. `TeX Live 2026`, reported with each result. */
  texlive: string;
  fetchBlob: BlobFetcher;
}

/** Result of {@link compileProject}, with the local files to publish. */
export interface LocalCompileResult {
  result: Omit<CompileResult, 'outputs'>;
  dirs: ProjectDirs;
  /** Files of the output folder worth publishing, relative to `dirs.out`. */
  publishable: OutputFile[];
  run: SandboxRun;
}

/** Largest log the worker reads; TeX logs of huge documents stay far below. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const PAGES = /Output written on .*?\((\d+) pages?/g;
/** Generated files users may want, besides the PDF (SPEC §3.3). */
const PUBLISHED_EXTENSIONS = [
  '.log',
  '.blg',
  '.synctex.gz',
  '.aux',
  '.bbl',
  '.ilg',
  '.glg',
  '.ind',
  '.gls',
];

/**
 * A failure detected by the worker rather than read from a log. The message is
 * a stable code the interface translates; the context carries its value.
 */
/** Characters of console output kept with a NO_OUTPUT diagnostic. */
const CONSOLE_TAIL = 2000;

function compilerDiagnostic(code: string, value = '', file: string | null = null): Diagnostic {
  return { level: 'error', source: 'compiler', file, line: null, message: code, context: value };
}

/** Last page count TeX reported, or null when it wrote no output. */
export function pagesFromLog(log: string): number | null {
  let pages: number | null = null;
  for (const match of log.matchAll(PAGES)) pages = Number(match[1]);
  return pages;
}

/** Errors first, then warnings, then bad boxes, cut to {@link MAX_DIAGNOSTICS}. */
export function rankDiagnostics(entries: readonly LogEntry[]): {
  diagnostics: Diagnostic[];
  truncated: boolean;
} {
  const rank = { error: 0, warning: 1, badbox: 2 } as const;
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    const key = `${entry.level}|${entry.file ?? ''}|${String(entry.line)}|${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const sorted = [...unique].sort((a, b) => rank[a.level] - rank[b.level]);
  return {
    diagnostics: sorted.slice(0, MAX_DIAGNOSTICS).map((entry) => ({
      level: entry.level,
      source: entry.source,
      file: entry.file,
      ...(entry.externalFile === undefined ? {} : { externalFile: entry.externalFile }),
      line: entry.line,
      message: entry.message,
      context: entry.context,
    })),
    truncated: sorted.length > MAX_DIAGNOSTICS,
  };
}

/**
 * Finds the line where a runaway argument starts. TeX prints the argument it
 * read, not where it began, so the first words are looked up in the file.
 */
export function locateRunaway(source: string, runaway: string): number | null {
  const words = runaway
    .replace(/^\{/, '')
    .split('\\')[0]
    ?.trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(' ');
  if (words === undefined || words.length < 4) return null;
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => line.replace(/\s+/g, ' ').includes(words));
  return index === -1 ? null : index + 1;
}

async function resolveRunaways(entries: LogEntry[], dirs: ProjectDirs): Promise<void> {
  for (const entry of entries) {
    if (entry.runaway === undefined || entry.line !== null || entry.file === null) continue;
    const source = await readSandboxFile(join(dirs.src, entry.file), MAX_LOG_BYTES);
    if (source) entry.line = locateRunaway(source.toString('utf8'), entry.runaway);
  }
}

function outcomeOf(run: SandboxRun, errors: number, pdf: boolean): CompileOutcome {
  if (run.cancelled) return 'cancelled';
  if (run.timedOut) return 'timeout';
  if (run.outputExceeded) return 'failure';
  return errors === 0 && pdf ? 'success' : 'failure';
}

/**
 * Compiles a project: synchronises its working directory, runs latexmk in the
 * sandbox and analyses the logs. Pure of any queue or storage concern, so that
 * the worker and the corpus test share it.
 */
export async function compileProject(
  job: CompileJob,
  env: CompileEnvironment,
  signal?: AbortSignal,
): Promise<LocalCompileResult> {
  const started = Date.now();
  const dirs = projectDirs(env.workRoot, job.projectId);
  if (job.clean) await cleanOutputs(dirs);
  await syncSources(dirs, job.manifest, env.fetchBlob);

  const { cwd, jobname } = splitMainFile(job.mainFile);
  const shellEscape = effectiveShellEscape(job.shellEscape, env.allowFullShellEscape);
  const run = await runSandboxed(
    {
      texliveDir: env.texliveDir,
      assetsDir: env.assetsDir,
      srcDir: dirs.src,
      outDir: dirs.out,
      texmfDir: env.texmfDir,
    },
    env.limits,
    cwd,
    latexmkArgv(job, shellEscape, splitMainFile(job.mainFile).base),
    signal,
  );

  const pathContext = { projectRoot: SANDBOX_PROJECT, cwd, outDir: SANDBOX_OUT };
  const log = (await readSandboxFile(join(dirs.out, `${jobname}.log`), MAX_LOG_BYTES))?.toString(
    'utf8',
  );
  const entries: LogEntry[] = log
    ? parseTexLog(log, { ...pathContext, mainFile: job.mainFile })
    : [];
  const blg = (await readSandboxFile(join(dirs.out, `${jobname}.blg`), MAX_LOG_BYTES))?.toString(
    'utf8',
  );
  if (blg) {
    entries.push(
      ...(blg.startsWith('This is BibTeX')
        ? parseBibtexLog(blg, pathContext)
        : parseBiberLog(blg, pathContext)),
    );
  }
  await resolveRunaways(entries, dirs);

  const outputs = await listOutputs(dirs);
  const pdfName = `${jobname}.pdf`;
  // A PDF left by an earlier run must not pass for this one: TeX says when it wrote one.
  const pdf =
    log !== undefined && pagesFromLog(log) !== null && outputs.some((file) => file.name === pdfName)
      ? pdfName
      : null;

  const ranked = rankDiagnostics(entries);
  const diagnostics = ranked.diagnostics;
  if (run.timedOut) {
    diagnostics.unshift(compilerDiagnostic('TIMEOUT', String(env.limits.timeoutMs / 1000)));
  } else if (run.outputExceeded) {
    diagnostics.unshift(
      compilerDiagnostic(
        'OUTPUT_LIMIT',
        String(Math.round(env.limits.maxOutputBytes / 1024 / 1024)),
      ),
    );
  } else if (!run.cancelled && pdf === null && !diagnostics.some((d) => d.level === 'error')) {
    // The end of the console says why: latexmk refusing to start, a missing main file, a sandbox failure.
    diagnostics.unshift(
      compilerDiagnostic('NO_OUTPUT', run.console.slice(-CONSOLE_TAIL), job.mainFile),
    );
  }
  const errors = diagnostics.filter((d) => d.level === 'error').length;

  const publishable = outputs.filter(
    (file) =>
      file.name === pdfName ||
      (!file.name.includes('/') && PUBLISHED_EXTENSIONS.some((ext) => file.name.endsWith(ext))),
  );

  return {
    result: {
      outcome: outcomeOf(run, errors, pdf !== null),
      durationMs: Date.now() - started,
      pdf,
      pages: pdf === null || log === undefined ? null : pagesFromLog(log),
      diagnostics,
      truncated: ranked.truncated,
      texlive: env.texlive,
      shellEscapeDowngraded: shellEscape !== job.shellEscape,
    },
    dirs,
    publishable,
    run,
  };
}
