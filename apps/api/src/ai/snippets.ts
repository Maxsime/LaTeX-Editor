import { createHash, randomUUID } from 'node:crypto';
import { type CompileJob, type CompileResult, compileResult, type Manifest } from '@galley/shared';
import type { Queue, QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import { assertCompileTime, recordSnippetTime } from '../admin/quotas.js';
import { instanceSettingsOf } from '../admin/settings.js';
import type { AppContext } from '../context.js';
import { sha256 } from '../files/classify.js';
import { deleteCompileOutputs } from '../storage/compiles.js';
import { storeBlobs } from '../storage/blobs.js';
import { textBytes } from '../yjs/text.js';

/** Runs a compile job outside any project's history; null when no worker answered in time. */
export type SnippetCompiler = (
  job: CompileJob,
  timeoutMs?: number,
) => Promise<CompileResult | null>;

/** Longest wait for a preview: a standalone fragment compiles in a second or two. */
const SNIPPET_TIMEOUT_MS = 30_000;
/** Previews older than this are deleted from storage by the maintenance job. */
export const SNIPPET_LIFETIME_MS = 3_600_000;
const SNIPPETS_KEY = 'ai:snippets';
export const SNIPPET_JOB = 'snippet';

/**
 * Builds the compiler over the ordinary compile queue. The job is named
 * `snippet` and has no row in `compile_runs`, so the follow-up of project
 * compilations ignores it.
 */
export function createSnippetCompiler(
  queue: Queue<CompileJob, unknown>,
  events: QueueEvents,
): SnippetCompiler {
  return async (data, timeoutMs = SNIPPET_TIMEOUT_MS) => {
    const job = await queue.add(SNIPPET_JOB, data, {
      jobId: data.compileId,
      attempts: 1,
      removeOnComplete: { age: 600 },
      removeOnFail: { age: 600 },
    });
    let value: unknown;
    try {
      value = await job.waitUntilFinished(events, timeoutMs);
    } catch {
      return null;
    }
    const parsed = compileResult.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
}

/**
 * A stable pseudo-project per (project, user): its own compile lock and work
 * directory, so a preview never waits for nor disturbs the project's build.
 */
export function snippetProjectId(projectId: string, userId: string): string {
  const hex = createHash('sha256').update(`snippet:${projectId}:${userId}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

export interface SnippetOutcome {
  compileId: string | null;
  outcome: 'success' | 'failure' | 'timeout' | 'error';
  errors: string[];
}

/** Where an isolated preview runs: alongside the project's files rather than alone. */
export interface SnippetSetting {
  engine: CompileJob['engine'];
  /** Files beside the document, e.g. the project's images and packages. */
  manifest: Manifest;
  texmfManifest: Manifest;
  /** Path of the document among them. */
  mainFile: string;
  /** The project's own, for a document that is the project itself; BibTeX otherwise. */
  bibTool?: CompileJob['bibTool'];
  /** Longer than a fragment's for a whole project. */
  timeoutMs?: number;
}

/** Compiles a standalone document in the sandbox and keeps its PDF for an hour. */
export async function compileSnippet(
  context: AppContext,
  projectId: string,
  userId: string,
  document: string,
  setting: SnippetSetting = {
    engine: 'pdflatex',
    manifest: {},
    texmfManifest: {},
    mainFile: 'main.tex',
  },
): Promise<SnippetOutcome> {
  const { database, s3, config, snippets, redis } = context;
  if (snippets === undefined) return { compileId: null, outcome: 'error', errors: [] };
  const { quotas } = await instanceSettingsOf(context).get();
  await assertCompileTime(database.db, redis, quotas, userId);
  const bytes = textBytes(document);
  const hash = sha256(bytes);
  await storeBlobs(database.db, s3, config.S3_BUCKET, [
    { hash, size: bytes.length, mimeType: 'text/x-tex', bytes },
  ]);
  const compileId = randomUUID();
  const started = performance.now();
  const result = await snippets(
    {
      compileId,
      projectId: snippetProjectId(projectId, userId),
      manifest: { ...setting.manifest, [setting.mainFile]: hash },
      texmfManifest: setting.texmfManifest,
      mainFile: setting.mainFile,
      engine: setting.engine,
      bibTool: setting.bibTool ?? 'bibtex',
      shellEscape: 'disabled',
      draft: false,
      haltOnError: true,
      clean: true,
      chktexDisabled: [],
      precompilePreamble: false,
    },
    setting.timeoutMs,
  );
  await recordSnippetTime(redis, userId, (performance.now() - started) / 1000);
  if (result === null) return { compileId: null, outcome: 'error', errors: [] };
  await redis.zadd(
    SNIPPETS_KEY,
    Date.now(),
    JSON.stringify({ compileId, outputs: result.outputs.map((output) => output.name) }),
  );
  const errors = result.diagnostics
    .filter((diagnostic) => diagnostic.level === 'error')
    .slice(0, 10)
    .map((diagnostic) =>
      diagnostic.line === null
        ? diagnostic.message
        : `l.${String(diagnostic.line)}: ${diagnostic.message}`,
    );
  const outcome =
    result.outcome === 'success' && result.pdf !== null
      ? 'success'
      : result.outcome === 'timeout'
        ? 'timeout'
        : result.outcome === 'failure' || result.outcome === 'success'
          ? 'failure'
          : 'error';
  return { compileId: result.pdf === null ? null : compileId, outcome, errors };
}

/** Deletes the outputs of previews older than {@link SNIPPET_LIFETIME_MS}. */
export async function purgeSnippets(
  context: Pick<AppContext, 's3' | 'config'> & { redis: Redis },
  now: Date,
): Promise<number> {
  const limit = now.getTime() - SNIPPET_LIFETIME_MS;
  const expired = await context.redis.zrangebyscore(SNIPPETS_KEY, 0, limit);
  for (const member of expired) {
    try {
      const { compileId, outputs } = JSON.parse(member) as { compileId: string; outputs: string[] }; // Written above by compileSnippet.
      await deleteCompileOutputs(context.s3, context.config.S3_BUCKET, compileId, outputs);
    } catch {
      // A member that cannot be read is dropped all the same.
    }
    await context.redis.zrem(SNIPPETS_KEY, member);
  }
  return expired.length;
}
