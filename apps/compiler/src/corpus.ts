import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, appendFile, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  type CompileJob,
  DEFAULT_CHKTEX_DISABLED,
  type Diagnostic,
  type Manifest,
  synctexInputToProjectPath,
} from '@galley/shared';
import * as z from 'zod/mini';
import { type CompileEnvironment, compileProject, type LocalCompileResult } from './compile.js';
import { splitMainFile } from './latexmk.js';
import { texliveBinDir } from './sandbox.js';
import { runSynctex, type SynctexEnvironment } from './synctex.js';
import { type BlobFetcher, readSandboxFile } from './workdir.js';

/** A diagnostic a corpus project expects; `message` is a substring. */
const expectedDiagnostic = z.object({
  file: z.nullable(z.string()),
  line: z.optional(z.nullable(z.number())),
  message: z.optional(z.string()),
});

const expectation = z.object({
  outcome: z.optional(z.enum(['success', 'failure', 'timeout', 'cancelled'])),
  /** Whether a PDF must (true) or must not (false) be produced; defaults to outcome = success. */
  pdf: z.optional(z.boolean()),
  minPages: z.optional(z.number()),
  errors: z.optional(z.array(expectedDiagnostic)),
  warnings: z.optional(z.array(expectedDiagnostic)),
  /** Substrings no warning may contain, e.g. `undefined` for resolved citations. */
  absentWarnings: z.optional(z.array(z.string())),
  /** Strings that must not appear in any file the compilation left, nor in its console. */
  forbidden: z.optional(z.array(z.string())),
  /** Strings the main log must contain. */
  logContains: z.optional(z.array(z.string())),
  /** Paths that must not exist after the run, relative to the project's work folder or absolute. */
  forbiddenPaths: z.optional(z.array(z.string())),
  /** Longest acceptable recompilation after `hotEdit`, in milliseconds. */
  hotRecompileMs: z.optional(z.number()),
  /**
   * Longest acceptable median of SyncTeX queries, in milliseconds. Every line of
   * every source file is sent from the source to the PDF and back, through the
   * sandboxed binary the worker uses (SPEC §6.5).
   */
  synctexMedianMs: z.optional(z.number()),
  /** chktex warnings the run must report. */
  lint: z.optional(z.array(expectedDiagnostic)),
  /** texcount results: least total of words, and the section titles in order. */
  words: z.optional(z.object({ minTotal: z.number(), sections: z.array(z.string()) })),
});

const corpusRun = z.object({
  main: z.string(),
  engine: z.optional(z.enum(['pdflatex', 'xelatex', 'lualatex'])),
  shellEscape: z.optional(z.enum(['disabled', 'restricted', 'full'])),
  timeoutS: z.optional(z.number()),
  /** File modified before a second compilation, to measure a hot recompilation. */
  hotEdit: z.optional(z.string()),
  expect: expectation,
});

/** Content of a corpus project's `expected.json`. */
export const corpusExpectations = z.object({
  description: z.string(),
  runs: z.array(corpusRun),
});
export type CorpusRun = z.infer<typeof corpusRun>;

/** Outcome of one run of a corpus project. */
export interface RunReport {
  project: string;
  main: string;
  engine: string;
  durationMs: number;
  hotDurationMs?: number;
  /** Median duration of the SyncTeX queries, when the run measures them. */
  synctexMedianMs?: number;
  /** Share of source lines that a SyncTeX round trip leads back to (SPEC §9 J4, A1). */
  synctexAccuracy?: number;
  failures: string[];
}

/** Placeholder in `forbidden` replaced by the canary planted in the worker's environment. */
const CANARY_PLACEHOLDER = '$CANARY';

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(join(dir, entry.name), path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/**
 * Builds a manifest of a folder, and a blob fetcher serving its files by
 * digest. A `texmf/` folder stands for the owner's personal texmf tree.
 */
async function snapshot(
  dir: string,
): Promise<{ manifest: Manifest; texmf: Manifest; fetch: BlobFetcher }> {
  const manifest: Manifest = {};
  const texmf: Manifest = {};
  const byHash = new Map<string, string>();
  for (const path of await listFiles(dir)) {
    if (path === 'expected.json') continue;
    const hash = createHash('sha256')
      .update(await readFile(join(dir, path)))
      .digest('hex');
    if (path.startsWith('texmf/')) texmf[path.slice('texmf/'.length)] = hash;
    else manifest[path] = hash;
    byHash.set(hash, join(dir, path));
  }
  return {
    manifest,
    texmf,
    fetch: (hash) => {
      const path = byHash.get(hash);
      if (path === undefined) return Promise.reject(new Error(`unknown blob ${hash}`));
      return Promise.resolve(createReadStream(path));
    },
  };
}

function matches(diagnostic: Diagnostic, expected: z.infer<typeof expectedDiagnostic>): boolean {
  return (
    diagnostic.file === expected.file &&
    (expected.line === undefined || diagnostic.line === expected.line) &&
    (expected.message === undefined || diagnostic.message.includes(expected.message))
  );
}

function describeDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map(
      (d) =>
        `${d.level} ${d.file ?? '-'}:${String(d.line)} ${d.message}` +
        (d.source === 'compiler' && d.context !== '' ? ` [${d.context.trim()}]` : ''),
    )
    .join(' | ');
}

/** Reads every regular file a compilation left, without following links. */
async function readLeftovers(local: LocalCompileResult): Promise<string> {
  const texts: string[] = [local.run.console];
  for (const dir of [local.dirs.src, local.dirs.out]) {
    for (const path of await listFiles(dir).catch(() => [])) {
      const content = await readSandboxFile(join(dir, path), 64 * 1024 * 1024);
      if (content) texts.push(content.toString('latin1'));
    }
  }
  return texts.join('\n');
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Checks a compilation against what its corpus entry expects. */
export async function checkRun(
  run: CorpusRun,
  local: LocalCompileResult,
  canary: string,
): Promise<string[]> {
  const failures: string[] = [];
  const { result } = local;
  const expected = run.expect;
  const errors = result.diagnostics.filter((d) => d.level === 'error');
  const warnings = result.diagnostics.filter((d) => d.level === 'warning');

  if (expected.outcome !== undefined && result.outcome !== expected.outcome) {
    failures.push(
      `outcome ${result.outcome}, expected ${expected.outcome} (${describeDiagnostics(errors)})`,
    );
  }
  const wantPdf = expected.pdf ?? expected.outcome === 'success';
  if (expected.pdf !== undefined || expected.outcome === 'success') {
    if (wantPdf !== (result.pdf !== null)) {
      failures.push(wantPdf ? 'no PDF produced' : `unexpected PDF ${String(result.pdf)}`);
    }
  }
  if (expected.minPages !== undefined && (result.pages ?? 0) < expected.minPages) {
    failures.push(`${String(result.pages)} pages, expected at least ${String(expected.minPages)}`);
  }
  for (const error of expected.errors ?? []) {
    if (!errors.some((d) => matches(d, error))) {
      failures.push(`missing error ${JSON.stringify(error)} among ${describeDiagnostics(errors)}`);
    }
  }
  for (const warning of expected.warnings ?? []) {
    if (!warnings.some((d) => matches(d, warning))) {
      failures.push(
        `missing warning ${JSON.stringify(warning)} among ${describeDiagnostics(warnings)}`,
      );
    }
  }
  for (const text of expected.absentWarnings ?? []) {
    const found = warnings.find((d) => d.message.includes(text));
    if (found) failures.push(`unexpected warning: ${found.message}`);
  }
  if (expected.forbidden !== undefined) {
    const leftovers = await readLeftovers(local);
    for (const text of expected.forbidden) {
      const needle = text === CANARY_PLACEHOLDER ? canary : text;
      if (leftovers.includes(needle)) failures.push(`forbidden content found: ${text}`);
    }
  }
  if (expected.logContains !== undefined) {
    const { jobname } = splitMainFile(run.main);
    const log =
      (await readSandboxFile(join(local.dirs.out, `${jobname}.log`), 64 * 1024 * 1024))?.toString(
        'utf8',
      ) ?? '';
    for (const text of expected.logContains) {
      if (!log.includes(text)) failures.push(`log lacks: ${text}`);
    }
  }
  for (const warning of expected.lint ?? []) {
    if (!result.lint.some((d) => matches(d, warning))) {
      failures.push(
        `missing chktex warning ${JSON.stringify(warning)} among ${describeDiagnostics(result.lint)}`,
      );
    }
  }
  if (expected.words !== undefined) {
    const count = result.wordCount;
    const total =
      count === null ? 0 : count.total.text + count.total.headers + count.total.captions;
    if (total < expected.words.minTotal) {
      failures.push(
        `${String(total)} words counted, expected at least ${String(expected.words.minTotal)}`,
      );
    }
    const titles = count?.sections.map((section) => section.title) ?? [];
    if (JSON.stringify(titles) !== JSON.stringify(expected.words.sections)) {
      failures.push(`sections counted ${JSON.stringify(titles)}`);
    }
  }
  for (const path of expected.forbiddenPaths ?? []) {
    const target = isAbsolute(path) ? path : resolve(local.dirs.root, path);
    if (await exists(target)) failures.push(`file written outside the project: ${path}`);
  }
  return failures;
}

/**
 * Sends each line of the project's sources to the PDF and the first box found
 * back to the source, as the editor does, and times every query.
 */
/** Least share of lines a SyncTeX round trip must lead back to (SPEC §9 J4, A1). */
const SYNCTEX_MIN_ACCURACY = 0.95;

async function checkSynctex(
  local: LocalCompileResult,
  job: CompileJob,
  texliveDir: string,
  limitMs: number,
  report: RunReport,
): Promise<string[]> {
  const { jobname } = splitMainFile(job.mainFile);
  const synctexFile = `${jobname}.synctex.gz`;
  const env: SynctexEnvironment = {
    cacheDir: await mkdtemp(join(local.dirs.root, 'synctex-')),
    maxEntries: 4,
    texliveBin: texliveBinDir(texliveDir),
    fetchOutput: (_compileId, name) =>
      Promise.resolve(createReadStream(join(local.dirs.out, name))),
  };
  const timings: number[] = [];
  let boxes = 0;
  let found = 0;
  const missed: string[] = [];
  const timed = async <T>(query: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const result = await query();
    timings.push(performance.now() - started);
    return result;
  };
  for (const file of Object.keys(job.manifest).filter((path) => path.endsWith('.tex'))) {
    const lines = (await readFile(join(local.dirs.src, file), 'utf8')).split('\n');
    // Only running text counts: the preamble, blank lines and comments typeset nothing.
    const body =
      file === job.mainFile ? lines.findIndex((text) => text.includes('\\begin{document}')) + 1 : 0;
    for (let line = body + 1; line <= lines.length; line += 1) {
      const text = lines[line - 1]?.trim() ?? '';
      if (text === '' || text.startsWith('%')) continue;
      const view = await timed(() =>
        runSynctex(env, {
          kind: 'view',
          compileId: job.compileId,
          synctexFile,
          file,
          line,
          column: 0,
        }),
      );
      const box = view.kind === 'view' ? view.boxes[0] : undefined;
      if (box === undefined) continue;
      boxes += 1;
      const edit = await timed(() =>
        runSynctex(env, {
          kind: 'edit',
          compileId: job.compileId,
          synctexFile,
          page: box.page,
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        }),
      );
      // A paragraph often ends on the next line; SyncTeX may report either.
      const source = edit.kind === 'edit' ? edit.source : null;
      if (
        source !== null &&
        synctexInputToProjectPath(source.input) === file &&
        Math.abs(source.line - line) <= 1
      ) {
        found += 1;
      } else {
        const got = source === null ? 'nothing' : `${source.input}:${String(source.line)}`;
        missed.push(`${file}:${String(line)} -> ${got}`);
      }
    }
  }
  const failures: string[] = [];
  if (boxes === 0) failures.push('SyncTeX found no box for any source line');
  report.synctexAccuracy = boxes === 0 ? 0 : found / boxes;
  if (found < boxes * SYNCTEX_MIN_ACCURACY) {
    failures.push(
      `SyncTeX edit led back to ${String(found)} of ${String(boxes)} lines, below ${String(SYNCTEX_MIN_ACCURACY * 100)} %: ${missed.slice(0, 5).join(', ')}`,
    );
  }
  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)] ?? 0;
  report.synctexMedianMs = median;
  if (median > limitMs) {
    failures.push(`SyncTeX median ${median.toFixed(0)} ms, limit ${String(limitMs)} ms`);
  }
  return failures;
}

/** Options of {@link runCorpus}. */
export interface CorpusOptions {
  environment: CompileEnvironment;
  /** Secret planted in the worker's environment; finding it anywhere is a leak. */
  canary: string;
  /** Only projects whose folder name contains this text. */
  filter?: string;
  onReport?: (report: RunReport) => void;
}

/**
 * Compiles every project of the corpus (SPEC §8) with the real compilation
 * module and sandbox, and checks each run against its `expected.json`.
 */
export async function runCorpus(root: string, options: CorpusOptions): Promise<RunReport[]> {
  const reports: RunReport[] = [];
  const projects = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.includes(options.filter ?? ''))
    .map((entry) => entry.name)
    .sort();
  for (const project of projects) {
    const dir = join(root, project);
    const expectations = corpusExpectations.parse(
      JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')),
    );
    for (const run of expectations.runs) {
      const source = await snapshot(dir);
      const job: CompileJob = {
        compileId: randomUUID(),
        projectId: randomUUID(),
        manifest: source.manifest,
        texmfManifest: source.texmf,
        mainFile: run.main,
        engine: run.engine ?? 'pdflatex',
        chktexDisabled: DEFAULT_CHKTEX_DISABLED,
        bibTool: 'biber',
        shellEscape: run.shellEscape ?? 'restricted',
        draft: false,
        haltOnError: false,
        clean: false,
      };
      const environment: CompileEnvironment = {
        ...options.environment,
        fetchBlob: source.fetch,
        limits:
          run.timeoutS === undefined
            ? options.environment.limits
            : { ...options.environment.limits, timeoutMs: run.timeoutS * 1000 },
      };
      const report: RunReport = {
        project,
        main: run.main,
        engine: job.engine,
        durationMs: 0,
        failures: [],
      };
      try {
        const local = await compileProject(job, environment);
        report.durationMs = local.result.durationMs;
        report.failures.push(...(await checkRun(run, local, options.canary)));
        if (run.expect.synctexMedianMs !== undefined) {
          report.failures.push(
            ...(await checkSynctex(
              local,
              job,
              options.environment.texliveDir,
              run.expect.synctexMedianMs,
              report,
            )),
          );
        }
        if (run.hotEdit !== undefined && run.expect.hotRecompileMs !== undefined) {
          // Change one source as a user would, then recompile in the same work folder.
          const edited = join(local.dirs.src, run.hotEdit);
          await appendFile(edited, `\n% hot edit ${new Date().toISOString()}\n`);
          const editedHash = createHash('sha256')
            .update(await readFile(edited))
            .digest('hex');
          const hot = await compileProject(
            {
              ...job,
              compileId: randomUUID(),
              manifest: { ...job.manifest, [run.hotEdit]: editedHash },
            },
            {
              ...environment,
              fetchBlob: (hash) =>
                hash === editedHash
                  ? Promise.resolve(createReadStream(edited))
                  : source.fetch(hash),
            },
          );
          report.hotDurationMs = hot.result.durationMs;
          if (hot.result.outcome !== 'success')
            report.failures.push(`hot recompilation ${hot.result.outcome}`);
          if (hot.result.durationMs > run.expect.hotRecompileMs) {
            report.failures.push(
              `hot recompilation took ${String(hot.result.durationMs)} ms, limit ${String(run.expect.hotRecompileMs)} ms`,
            );
          }
        }
      } catch (error) {
        report.failures.push(`crashed: ${error instanceof Error ? error.message : String(error)}`);
      }
      options.onReport?.(report);
      reports.push(report);
    }
  }
  return reports;
}

/** Path of a report entry, for messages. */
export function runLabel(report: RunReport, root: string): string {
  return relative(root, join(root, report.project, report.main));
}
