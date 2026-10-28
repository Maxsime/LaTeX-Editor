import { rm, stat, writeFile } from 'node:fs/promises';
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
  formatArgv,
  PREAMBLE_FORMAT,
  PREAMBLE_STAMP,
  preambleFingerprint,
  preambleOf,
  usesPreambleFormat,
} from './preamble.js';
import { chktexArgv, lintedFiles, parseChktex, parseTexcount, texcountArgv } from './tools.js';
import {
  runSandboxed,
  SANDBOX_OUT,
  SANDBOX_PROJECT,
  type SandboxLimits,
  type SandboxPaths,
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
  syncTexmf,
} from './workdir.js';

/** Everything a compilation needs besides the job. */
export interface CompileEnvironment {
  workRoot: string;
  texliveDir: string;
  assetsDir: string;
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

/** Longest chktex or texcount may run; both take well under a second on real documents. */
const TOOL_TIMEOUT_MS = 30_000;

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

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** State of the precompiled preamble before a compilation. */
interface PreparedFormat {
  /** The compilation can load the format. */
  ready: boolean;
  /** The format was just built: its first compilation checks it. */
  fresh: boolean;
  /** What the stamp records, to mark the format unusable after its check. */
  fingerprint: string;
  warning: Diagnostic | null;
}

/** Stamp of a format whose first compilation failed where a normal one succeeded. */
const UNUSABLE = 'unusable:';

function formatWarning(job: CompileJob, code: string, context = ''): Diagnostic {
  return {
    level: 'warning',
    source: 'compiler',
    file: job.mainFile,
    line: null,
    message: code,
    context,
  };
}

/**
 * Makes sure the output folder holds a format of the current preamble,
 * building it when the preamble or what it loads changed. A preamble whose
 * format proved unusable is not built again until it changes.
 */
async function preparePreambleFormat(
  job: CompileJob,
  env: CompileEnvironment,
  dirs: ProjectDirs,
  paths: SandboxPaths,
  shellEscape: CompileJob['shellEscape'],
  signal?: AbortSignal,
): Promise<PreparedFormat> {
  const source = await readSandboxFile(join(dirs.src, job.mainFile), MAX_LOG_BYTES);
  const preamble = source === null ? null : preambleOf(source.toString('utf8'));
  const fmt = join(dirs.out, `${PREAMBLE_FORMAT}.fmt`);
  const stamp = join(dirs.out, PREAMBLE_STAMP);
  const none = { ready: false, fresh: false, fingerprint: '', warning: null };
  if (preamble === null) return none;
  const fingerprint = preambleFingerprint(preamble, job, shellEscape, env.texlive);
  const stamped = (await readSandboxFile(stamp, 1024))?.toString('utf8');
  if (stamped === fingerprint && (await exists(fmt))) {
    return { ready: true, fresh: false, fingerprint, warning: null };
  }
  if (stamped === `${UNUSABLE}${fingerprint}`) {
    return { ...none, warning: formatWarning(job, 'PREAMBLE_FORMAT_UNUSABLE') };
  }

  await rm(fmt, { force: true });
  await rm(stamp, { force: true });
  const { cwd, base } = splitMainFile(job.mainFile);
  const build = await runSandboxed(
    paths,
    env.limits,
    cwd,
    formatArgv(base, shellEscape, SANDBOX_OUT),
    signal,
  );
  if (build.exitCode === 0 && (await exists(fmt))) {
    await writeFile(stamp, fingerprint);
    return { ready: true, fresh: true, fingerprint, warning: null };
  }
  await rm(fmt, { force: true });
  if (build.cancelled) return none;
  return {
    ...none,
    warning: formatWarning(job, 'PREAMBLE_FORMAT_FAILED', build.console.slice(-CONSOLE_TAIL)),
  };
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
  await syncTexmf(dirs, job.texmfManifest, env.fetchBlob);

  const { cwd, jobname, base } = splitMainFile(job.mainFile);
  const shellEscape = effectiveShellEscape(job.shellEscape, env.allowFullShellEscape);
  const paths = {
    texliveDir: env.texliveDir,
    assetsDir: env.assetsDir,
    srcDir: dirs.src,
    outDir: dirs.out,
    texmfDir: dirs.texmf,
  };
  // chktex and texcount only read the sources: they run beside latexmk, in their own sandboxes.
  const toolLimits = {
    ...env.limits,
    timeoutMs: Math.min(env.limits.timeoutMs, TOOL_TIMEOUT_MS),
    maxProcesses: Math.min(env.limits.maxProcesses, 8),
  };
  const pathContext = { projectRoot: SANDBOX_PROJECT, cwd, outDir: SANDBOX_OUT };
  /** One latexmk run and the entries of its logs. */
  const latexPass = async (format: boolean) => {
    const argv = latexmkArgv(job, shellEscape, base, format ? PREAMBLE_FORMAT : null);
    const pass = await runSandboxed(paths, env.limits, cwd, argv, signal);
    const texLog = (
      await readSandboxFile(join(dirs.out, `${jobname}.log`), MAX_LOG_BYTES)
    )?.toString('utf8');
    const found: LogEntry[] = texLog
      ? parseTexLog(texLog, { ...pathContext, mainFile: job.mainFile })
      : [];
    const blg = (await readSandboxFile(join(dirs.out, `${jobname}.blg`), MAX_LOG_BYTES))?.toString(
      'utf8',
    );
    if (blg) {
      found.push(
        ...(blg.startsWith('This is BibTeX')
          ? parseBibtexLog(blg, pathContext)
          : parseBiberLog(blg, pathContext)),
      );
    }
    return { run: pass, log: texLog, entries: found };
  };
  const errorCount = (found: readonly LogEntry[]) =>
    found.filter((entry) => entry.level === 'error').length;

  const [{ run, log, entries, preambleWarning }, lint, wordCount] = await Promise.all([
    (async () => {
      const prepared = usesPreambleFormat(job)
        ? await preparePreambleFormat(job, env, dirs, paths, shellEscape, signal)
        : null;
      const warning = prepared?.warning ?? null;
      const first = await latexPass(prepared?.ready === true);
      if (prepared?.fresh !== true || errorCount(first.entries) === 0 || first.run.cancelled) {
        return { ...first, preambleWarning: warning };
      }
      // Some preambles do not survive a dump (babel shorthands with cleveref, for one):
      // a new format whose compilation fails is checked against a normal compilation.
      await rm(join(dirs.out, `${jobname}.aux`), { force: true });
      await rm(join(dirs.out, `${jobname}.fdb_latexmk`), { force: true });
      const plain = await latexPass(false);
      if (errorCount(plain.entries) < errorCount(first.entries)) {
        await rm(join(dirs.out, `${PREAMBLE_FORMAT}.fmt`), { force: true });
        await writeFile(join(dirs.out, PREAMBLE_STAMP), `${UNUSABLE}${prepared.fingerprint}`);
        return { ...plain, preambleWarning: formatWarning(job, 'PREAMBLE_FORMAT_UNUSABLE') };
      }
      return { ...plain, preambleWarning: warning };
    })(),
    runSandboxed(
      paths,
      toolLimits,
      '',
      chktexArgv(lintedFiles(Object.keys(job.manifest)), job.chktexDisabled),
      signal,
    ).then((tool) => parseChktex(tool.console)),
    runSandboxed(paths, toolLimits, cwd, texcountArgv(base), signal).then((tool) =>
      parseTexcount(tool.console),
    ),
  ]);
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
  if (preambleWarning !== null) diagnostics.push(preambleWarning);
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
      lint: run.cancelled ? [] : lint,
      wordCount: run.cancelled ? null : wordCount,
    },
    dirs,
    publishable,
    run,
  };
}
