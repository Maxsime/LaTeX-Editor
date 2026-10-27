import * as z from 'zod/mini';

/** BullMQ queue consumed by the compiler workers. */
export const COMPILE_QUEUE = 'compile';

const sha256 = z
  .string()
  .check(z.regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 hex digest'));

/** Project-relative POSIX path. Absolute paths and `..` segments are rejected. */
export const projectPath = z.string().check(
  z.minLength(1),
  z.maxLength(1024),
  z.refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'must be a normalised relative path inside the project',
  ),
);

/** Snapshot of a project as `{path: blob digest}` (SPEC §6.2). */
export const manifest = z.record(projectPath, sha256);
export type Manifest = z.infer<typeof manifest>;

export const engine = z.enum(['pdflatex', 'xelatex', 'lualatex']);
export const bibTool = z.enum(['biber', 'bibtex']);
export const shellEscapeMode = z.enum(['disabled', 'restricted', 'full']);

/** Payload of a compile job (SPEC §6.3). */
export const compileJob = z.object({
  compileId: z.uuid(),
  projectId: z.uuid(),
  manifest,
  texmfManifest: manifest,
  mainFile: projectPath,
  engine,
  bibTool,
  shellEscape: shellEscapeMode,
  draft: z.boolean(),
  haltOnError: z.boolean(),
  /** Deletes the cached auxiliary files first ("clean and recompile"). */
  clean: z._default(z.boolean(), false),
  /** chktex warnings the project turned off (SPEC §3.7). */
  chktexDisabled: z._default(z.array(z.number().check(z.int(), z.gte(0), z.lte(99))), []),
});
export type CompileJob = z.infer<typeof compileJob>;

/** Object key of a content-addressed blob. */
export function blobKey(hash: string): string {
  return `blobs/${hash}`;
}

/** Object key of a file published by a compilation. */
export function compileOutputKey(compileId: string, name: string): string {
  return `compiles/${compileId}/${name}`;
}

/** Valkey channel on which the API asks workers to stop a running compilation. */
export const COMPILE_CANCEL_CHANNEL = 'compile:cancel';

/**
 * Valkey key marking a compilation as cancelled, for a worker that picks the
 * job up just after the cancellation was published.
 */
export function compileCancelKey(compileId: string): string {
  return `compile:cancel:${compileId}`;
}

/** Valkey key holding the lock of the compilation running for a project. */
export function compileLockKey(projectId: string): string {
  return `compile:lock:${projectId}`;
}

/** Valkey key where workers publish the TeX Live release they run. */
export const TEXLIVE_VERSION_KEY = 'compile:texlive';

/** Final state of a compilation run by a worker. */
export const compileOutcome = z.enum(['success', 'failure', 'timeout', 'cancelled', 'error']);
export type CompileOutcome = z.infer<typeof compileOutcome>;

/** Every state of a compilation, as stored by the API. */
export const compileStatus = z.enum([
  'queued',
  'running',
  'success',
  'failure',
  'timeout',
  'cancelled',
  'superseded',
  'error',
]);
export type CompileStatus = z.infer<typeof compileStatus>;

/** A located message of the compilation log (SPEC §6.4). */
export const diagnostic = z.object({
  level: z.enum(['error', 'warning', 'badbox']),
  source: z.enum(['tex', 'biber', 'bibtex', 'latexmk', 'compiler', 'chktex']),
  /** Project-relative path, or null when no project file is concerned. */
  file: z.nullable(z.string()),
  externalFile: z.optional(z.string()),
  line: z.nullable(z.number()),
  message: z.string(),
  context: z.string(),
});
export type Diagnostic = z.infer<typeof diagnostic>;

/** Most diagnostics a compilation keeps; a log can hold thousands of bad boxes. */
export const MAX_DIAGNOSTICS = 500;

/** A file published under `compiles/<compileId>/`. */
export const compileOutput = z.object({
  /** Name relative to the output folder, e.g. `main.pdf` or `chapters/one.aux`. */
  name: z.string(),
  size: z.number(),
});
export type CompileOutput = z.infer<typeof compileOutput>;

/** Words of one part of the document, as texcount counts them. */
export const wordTally = z.object({
  /** Words of running text. */
  text: z.number(),
  /** Words of headings. */
  headers: z.number(),
  /** Words of captions and other floats. */
  captions: z.number(),
});
export type WordTally = z.infer<typeof wordTally>;

/** Word count of the document, by section (SPEC §3.7). */
export const wordCount = z.object({
  total: wordTally,
  sections: z.array(z.object({ title: z.string(), ...wordTally.shape })),
});
export type WordCount = z.infer<typeof wordCount>;

/** Value a worker returns for a compile job. */
export const compileResult = z.object({
  outcome: compileOutcome,
  durationMs: z.number(),
  /** Name of the PDF among the outputs, when one was produced. */
  pdf: z.nullable(z.string()),
  pages: z.nullable(z.number()),
  diagnostics: z.array(diagnostic),
  /** True when diagnostics were cut at {@link MAX_DIAGNOSTICS}. */
  truncated: z.boolean(),
  outputs: z.array(compileOutput),
  texlive: z.string(),
  /** Set when shell-escape `full` was asked for but not allowed, and restricted used instead. */
  shellEscapeDowngraded: z.boolean(),
  /** chktex warnings on the project's sources; absent from results stored before J8. */
  lint: z._default(z.array(diagnostic), []),
  wordCount: z._default(z.nullable(wordCount), null),
});
export type CompileResult = z.infer<typeof compileResult>;
