import { createHash, randomUUID } from 'node:crypto';
import {
  ApiError,
  COMPILE_CANCEL_CHANNEL,
  compileCancelKey,
  type CompileJob,
  type CompileOptions,
  type CompileRequest,
  compileResult,
  type CompileRun,
  type CompileStatus,
  KEPT_COMPILES,
  type Manifest,
} from '@galley/shared';
import { compileRuns } from '@galley/db';
import type { Job, Queue } from 'bullmq';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';
import { takeSnapshot } from '../history/snapshots.js';
import { materializeProject } from '../materialize.js';
import type { ProjectRow } from '../projects/access.js';
import { publishProjectEvent } from '../projects/events.js';
import { deleteCompileOutputs } from '../storage/compiles.js';

export type CompileRunRow = typeof compileRuns.$inferSelect;

/** The compile queue as the API uses it: it only adds and removes jobs. */
export type CompileQueue = Queue<CompileJob, unknown>;

/** Machine reasons of an `error` status. */
export const compileFailureCodes = {
  /** The worker rejected or crashed on the job. */
  workerFailed: 'WORKER_FAILED',
  /** The job vanished from the queue before reporting a result. */
  lost: 'LOST',
} as const;

const PENDING: CompileStatus[] = ['queued', 'running'];

/** How long a cancellation stays on record for a worker that has not picked the job up yet. */
const CANCEL_TTL_S = 600;

/** Converts a stored compilation to its API shape. */
export function toCompileRun(row: CompileRunRow): CompileRun {
  return {
    id: row.id,
    status: row.status,
    engine: row.engine,
    mainFile: row.mainFile,
    options: row.options,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.result?.durationMs ?? null,
    pdf: row.result?.pdf ?? null,
    pages: row.result?.pages ?? null,
    diagnostics: row.result?.diagnostics ?? [],
    truncated: row.result?.truncated ?? false,
    outputs: row.result?.outputs ?? [],
    texlive: row.result?.texlive ?? null,
    shellEscapeDowngraded: row.result?.shellEscapeDowngraded ?? false,
    lint: row.result?.lint ?? [],
    wordCount: row.result?.wordCount ?? null,
  };
}

function manifestDigest(manifest: Manifest): string {
  const entries = Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/**
 * Moves pending compilations to a new status, only if they are still pending:
 * every API instance receives the same queue events, and the first one wins.
 *
 * @returns The rows actually changed.
 */
async function transition(
  context: AppContext,
  ids: string[],
  values: Partial<CompileRunRow> & { status: CompileStatus },
  from: CompileStatus[] = PENDING,
): Promise<CompileRunRow[]> {
  if (ids.length === 0) return [];
  const rows = await context.database.db
    .update(compileRuns)
    .set(values)
    .where(and(inArray(compileRuns.id, ids), inArray(compileRuns.status, from)))
    .returning();
  for (const row of rows) {
    await publishProjectEvent(context.redis, row.projectId, {
      type: 'compile.updated',
      compileId: row.id,
      status: row.status,
    });
  }
  return rows;
}

/** Moves compilations to a final status, then applies the retention rule to their projects. */
async function settle(
  context: AppContext,
  ids: string[],
  values: Partial<CompileRunRow> & { status: CompileStatus },
  logger: FastifyBaseLogger,
): Promise<CompileRunRow[]> {
  const rows = await transition(context, ids, values);
  for (const projectId of new Set(rows.map((row) => row.projectId))) {
    await enforceRetention(context, projectId, logger);
  }
  return rows;
}

/**
 * Snapshots the project and queues its compilation. A compilation of the same
 * project still waiting for a worker is withdrawn: only the newest sources
 * matter.
 */
export async function requestCompile(
  context: AppContext,
  project: ProjectRow,
  userId: string,
  request: CompileRequest,
  logger: FastifyBaseLogger,
): Promise<CompileRunRow> {
  if (project.mainFileId === null) throw new ApiError('NO_MAIN_FILE');
  const snapshot = await materializeProject(context, project.id);
  const mainFile = snapshot.paths.get(project.mainFileId);
  if (mainFile === undefined || !(mainFile in snapshot.manifest)) {
    throw new ApiError('NO_MAIN_FILE');
  }

  await supersedeWaiting(context, project.id, logger);

  const options: CompileOptions = {
    ...request,
    bibTool: project.bibTool,
    shellEscape: project.shellEscape,
  };
  const [row] = await context.database.db
    .insert(compileRuns)
    .values({
      id: randomUUID(),
      projectId: project.id,
      userId,
      engine: project.engine,
      mainFile,
      options,
      manifestDigest: manifestDigest(snapshot.manifest),
    })
    .returning();
  if (!row) throw new Error('compile run insert returned nothing');

  const job: CompileJob = {
    compileId: row.id,
    projectId: project.id,
    manifest: snapshot.manifest,
    // Personal texmf trees arrive with texmf projects.
    texmfManifest: {},
    mainFile,
    engine: project.engine,
    ...options,
    chktexDisabled: project.chktexDisabled,
  };
  await context.compileQueue.add('compile', job, {
    jobId: row.id,
    // A failed compilation is reported, not retried: the user decides.
    attempts: 1,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86_400 },
  });
  await publishProjectEvent(context.redis, project.id, {
    type: 'compile.updated',
    compileId: row.id,
    status: row.status,
  });
  return row;
}

/** Withdraws the project's compilations no worker has started. */
async function supersedeWaiting(
  context: AppContext,
  projectId: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  const pending = await context.database.db
    .select({ id: compileRuns.id })
    .from(compileRuns)
    .where(and(eq(compileRuns.projectId, projectId), inArray(compileRuns.status, PENDING)));
  const removed: string[] = [];
  for (const { id } of pending) {
    // Returns 0 for a job a worker holds, which then runs to completion.
    if ((await context.compileQueue.remove(id)) === 1) removed.push(id);
  }
  await settle(context, removed, { status: 'superseded', finishedAt: new Date() }, logger);
}

/**
 * Cancels a compilation. A waiting job is withdrawn at once; a running one is
 * stopped by its worker, which then reports it as cancelled.
 */
export async function cancelCompile(
  context: AppContext,
  row: CompileRunRow,
  logger: FastifyBaseLogger,
): Promise<void> {
  if (!PENDING.includes(row.status)) return;
  if ((await context.compileQueue.remove(row.id)) === 1) {
    await settle(context, [row.id], { status: 'cancelled', finishedAt: new Date() }, logger);
    return;
  }
  await context.redis.set(compileCancelKey(row.id), '1', 'EX', CANCEL_TTL_S);
  await context.redis.publish(COMPILE_CANCEL_CHANNEL, row.id);
}

/** Records a worker's result, then applies the retention rule. */
async function finish(
  context: AppContext,
  compileId: string,
  value: unknown,
  logger: FastifyBaseLogger,
): Promise<void> {
  const parsed = compileResult.safeParse(value);
  if (!parsed.success) {
    logger.error({ compileId }, 'compile result does not match its schema');
    await fail(context, compileId, compileFailureCodes.workerFailed, logger);
    return;
  }
  const { outcome, ...result } = parsed.data;
  const rows = await settle(
    context,
    [compileId],
    { status: outcome, result, finishedAt: new Date() },
    logger,
  );
  // A successful compilation marks a state worth keeping, if it is new (SPEC §6.7).
  for (const row of outcome === 'success' ? rows : []) {
    takeSnapshot(context, row.projectId, 'compile').catch((error: unknown) => {
      logger.error({ err: error, projectId: row.projectId }, 'snapshot after compilation failed');
    });
  }
}

async function fail(
  context: AppContext,
  compileId: string,
  code: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  await settle(
    context,
    [compileId],
    { status: 'error', failureCode: code, finishedAt: new Date() },
    logger,
  );
}

/**
 * Keeps the published files of the project's {@link KEPT_COMPILES} most recent
 * finished compilations and of its most recent PDF; older compilations are
 * deleted with their files.
 */
export async function enforceRetention(
  context: AppContext,
  projectId: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  const { db } = context.database;
  const finished = await db
    .select()
    .from(compileRuns)
    .where(and(eq(compileRuns.projectId, projectId), isNotNull(compileRuns.finishedAt)))
    .orderBy(desc(compileRuns.createdAt));
  const lastPdf = finished.find((row) => row.result?.pdf != null);
  const stale = finished.slice(KEPT_COMPILES).filter((row) => row.id !== lastPdf?.id);
  for (const row of stale) {
    try {
      await deleteCompileOutputs(
        context.s3,
        context.config.S3_BUCKET,
        row.id,
        (row.result?.outputs ?? []).map((output) => output.name),
      );
      await db.delete(compileRuns).where(eq(compileRuns.id, row.id));
    } catch (error) {
      // Left for the next compilation to retry.
      logger.warn({ err: error, compileId: row.id }, 'old compilation could not be deleted');
    }
  }
}

/**
 * Brings a pending compilation up to date from its job, for results the queue
 * events did not deliver (an API restart while the worker ran).
 */
export async function reconcile(
  context: AppContext,
  row: CompileRunRow,
  logger: FastifyBaseLogger,
): Promise<CompileRunRow> {
  if (!PENDING.includes(row.status)) return row;
  // The state first, then the job: a job read before it completes would carry no
  // return value, even if it is completed by the time its state is asked.
  const state = await context.compileQueue.getJobState(row.id);
  if (state === 'unknown') {
    await fail(context, row.id, compileFailureCodes.lost, logger);
  } else if (state === 'completed') {
    const job: Job<CompileJob, unknown> | undefined = await context.compileQueue.getJob(row.id);
    await finish(context, row.id, job?.returnvalue, logger);
  } else if (state === 'failed') {
    await fail(context, row.id, compileFailureCodes.workerFailed, logger);
  } else if (state === 'active' && row.status === 'queued') {
    await transition(context, [row.id], { status: 'running', startedAt: new Date() }, ['queued']);
  }
  const [current] = await context.database.db
    .select()
    .from(compileRuns)
    .where(eq(compileRuns.id, row.id));
  return current ?? row;
}

/** The queue events the API listens to. */
export interface CompileEventSource {
  on(event: 'active', listener: (args: { jobId: string }) => void): unknown;
  on(
    event: 'completed',
    listener: (args: { jobId: string; returnvalue: unknown }) => void,
  ): unknown;
  on(event: 'failed', listener: (args: { jobId: string; failedReason: string }) => void): unknown;
}

/** Follows the compile queue and records each state change of the compilations. */
export function followCompileEvents(
  context: AppContext,
  events: CompileEventSource,
  logger: FastifyBaseLogger,
): void {
  const run = (work: Promise<unknown>, jobId: string) => {
    work.catch((error: unknown) => {
      logger.error({ err: error, compileId: jobId }, 'compile event handling failed');
    });
  };
  events.on('active', ({ jobId }) => {
    run(
      transition(context, [jobId], { status: 'running', startedAt: new Date() }, ['queued']),
      jobId,
    );
  });
  events.on('completed', ({ jobId, returnvalue }) => {
    run(finish(context, jobId, returnvalue, logger), jobId);
  });
  events.on('failed', ({ jobId, failedReason }) => {
    logger.warn({ compileId: jobId, reason: failedReason }, 'compile job failed');
    run(fail(context, jobId, compileFailureCodes.workerFailed, logger), jobId);
  });
}
