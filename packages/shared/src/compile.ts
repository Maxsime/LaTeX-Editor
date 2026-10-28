import * as z from 'zod/mini';
import {
  bibTool,
  compileOutput,
  compileStatus,
  diagnostic,
  wordCount,
  engine,
  shellEscapeMode,
} from './compile-job.js';

/** Body of `POST /api/projects/:id/compile`; every option defaults to off. */
export const compileRequest = z.object({
  draft: z._default(z.boolean(), false),
  haltOnError: z._default(z.boolean(), false),
  /** Deletes the cached auxiliary files first ("clean and recompile"). */
  clean: z._default(z.boolean(), false),
  /** Compiles the text with every suggestion rejected: the version under review. */
  original: z._default(z.boolean(), false),
});
export type CompileRequest = z.infer<typeof compileRequest>;

/** Options a compilation ran with, as recorded by the API. */
export const compileOptions = z.object({
  draft: z.boolean(),
  haltOnError: z.boolean(),
  clean: z.boolean(),
  /** Absent from runs recorded before the option existed. */
  original: z._default(z.boolean(), false),
  bibTool,
  shellEscape: shellEscapeMode,
});
export type CompileOptions = z.infer<typeof compileOptions>;

/** A compilation as the API returns it. Result fields stay empty until it finishes. */
export const compileRun = z.object({
  id: z.uuid(),
  status: compileStatus,
  engine,
  /** Project-relative path of the main file. */
  mainFile: z.string(),
  options: compileOptions,
  createdAt: z.string(),
  startedAt: z.nullable(z.string()),
  finishedAt: z.nullable(z.string()),
  durationMs: z.nullable(z.number()),
  /** Name of the PDF among `outputs`, when one was produced. */
  pdf: z.nullable(z.string()),
  pages: z.nullable(z.number()),
  diagnostics: z.array(diagnostic),
  truncated: z.boolean(),
  outputs: z.array(compileOutput),
  texlive: z.nullable(z.string()),
  shellEscapeDowngraded: z.boolean(),
  lint: z.array(diagnostic),
  wordCount: z.nullable(wordCount),
});
export type CompileRun = z.infer<typeof compileRun>;

/** Body of `GET /api/projects/:id/compiles/latest`. */
export const latestCompileResponse = z.object({
  /** The most recent compilation, whatever its state. */
  latest: z.nullable(compileRun),
  /**
   * The most recent compilation that produced a PDF, so the viewer keeps
   * showing it while a newer one fails or runs.
   */
  lastPdf: z.nullable(compileRun),
});
export type LatestCompileResponse = z.infer<typeof latestCompileResponse>;

/** Body of `GET /api/compiler`. */
export const compilerInfo = z.object({
  /** TeX Live release announced by the workers, or null before any started. */
  texlive: z.nullable(z.string()),
});
export type CompilerInfo = z.infer<typeof compilerInfo>;

/** Statuses after which a compilation no longer changes. */
export const FINAL_COMPILE_STATUSES = [
  'success',
  'failure',
  'timeout',
  'cancelled',
  'superseded',
  'error',
] as const;

/** Whether a compilation has reached a state it will not leave. */
export function isFinalCompileStatus(status: z.infer<typeof compileStatus>): boolean {
  return (FINAL_COMPILE_STATUSES as readonly string[]).includes(status);
}

/** Finished compilations whose files stay downloadable, per project (besides the last PDF). */
export const KEPT_COMPILES = 3;

/** Longest fragment sent to an isolated preview; a page of LaTeX is far below. */
export const MAX_PREVIEW_CODE = 20_000;

/** Body of `POST /api/projects/:id/preview`: a fragment compiled alone (SPEC §3.3). */
export const previewRequest = z.object({
  code: z.string().check(z.minLength(1), z.maxLength(MAX_PREVIEW_CODE)),
});
export type PreviewRequest = z.infer<typeof previewRequest>;

/** Result of an isolated preview; the PDF stays available for an hour. */
export const previewResponse = z.object({
  /** Null when no PDF was produced. */
  compileId: z.nullable(z.uuid()),
  outcome: z.enum(['success', 'failure', 'timeout', 'error']),
  /** First errors of the log, as `l.N: message`. */
  errors: z.array(z.string()),
});
export type PreviewResponse = z.infer<typeof previewResponse>;
