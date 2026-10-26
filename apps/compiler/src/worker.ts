import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  COMPILE_CANCEL_CHANNEL,
  COMPILE_QUEUE,
  compileCancelKey,
  type CompileJob,
  compileJob,
  compileLockKey,
  type CompileOutput,
  type CompileResult,
  runHealthChecks,
  TEXLIVE_VERSION_KEY,
} from '@galley/shared';
import { createProbeServer, type Logger } from '@galley/shared/node';
import { DelayedError, type Job, UnrecoverableError, Worker } from 'bullmq';
import type { Server } from 'node:http';
import { Redis } from 'ioredis';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import { type CompileEnvironment, compileProject, type LocalCompileResult } from './compile.js';
import type { CompilerConfig } from './config.js';
import { enforceQuota, recordSize } from './evict.js';
import type { SandboxLimits } from './sandbox.js';
import type { TexLiveInfo } from './texlive.js';
import { type BlobFetcher, openSandboxFile } from './workdir.js';

/** Failure reasons recorded on jobs; the API maps them to user-facing messages. */
export const failureReasons = {
  invalidJob: 'INVALID_JOB',
} as const;

/** Delay before a job whose project is already compiling elsewhere is retried. */
const LOCK_RETRY_MS = 500;

/** Releases a lock only if it still belongs to the caller. */
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** What the service needs from the outside, replaceable in tests. */
export interface CompilerDependencies {
  texlive: TexLiveInfo;
  fetchBlob: BlobFetcher;
  /** Stores one output file under `compiles/<compileId>/<name>`. */
  publish: (compileId: string, name: string, body: Readable, size: number) => Promise<void>;
  compile?: (
    job: CompileJob,
    env: CompileEnvironment,
    signal: AbortSignal,
  ) => Promise<LocalCompileResult>;
}

export interface CompilerService {
  worker: Worker<unknown, CompileResult>;
  probeServer: Server;
  close(): Promise<void>;
}

/** Sandbox limits from the configuration (SPEC §6.3). */
export function limitsFromConfig(config: CompilerConfig): SandboxLimits {
  return {
    timeoutMs: config.COMPILER_TIMEOUT_S * 1000,
    memoryBytes: config.COMPILER_MEMORY_MB * 1024 * 1024,
    maxProcesses: config.COMPILER_MAX_PROCESSES,
    maxOutputBytes: config.COMPILER_MAX_OUTPUT_MB * 1024 * 1024,
  };
}

/** Starts the queue consumer, the cancellation listener and the probe server. */
export function createCompilerService(
  config: CompilerConfig,
  logger: Logger,
  version: string,
  dependencies: CompilerDependencies,
): CompilerService {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'compiler' });
  collectDefaultMetrics({ register: registry });
  const jobs = new Counter({
    name: 'galley_compile_jobs_total',
    help: 'Compile jobs handled, by outcome.',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });
  const durations = new Histogram({
    name: 'galley_compile_duration_seconds',
    help: 'Duration of compilations, from synchronisation to analysis.',
    labelNames: ['engine'] as const,
    buckets: [0.5, 1, 2, 4, 8, 15, 30, 60, 120, 180],
    registers: [registry],
  });

  const compile = dependencies.compile ?? compileProject;
  const limits = limitsFromConfig(config);
  const environment: CompileEnvironment = {
    workRoot: config.COMPILER_WORK_DIR,
    texliveDir: dependencies.texlive.dir,
    assetsDir: config.COMPILER_ASSETS_DIR,
    texmfDir: join(config.COMPILER_ASSETS_DIR, 'texmf'),
    limits,
    allowFullShellEscape: config.COMPILER_ALLOW_FULL_SHELL_ESCAPE,
    texlive: dependencies.texlive.release,
    fetchBlob: dependencies.fetchBlob,
  };
  const lockTtlMs = limits.timeoutMs + 5 * 60_000;

  const redis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 3 });
  const subscriber = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: null });
  const running = new Map<string, AbortController>();
  void subscriber.subscribe(COMPILE_CANCEL_CHANNEL);
  subscriber.on('message', (_channel: string, compileId: string) => {
    running.get(compileId)?.abort();
  });
  void redis.set(TEXLIVE_VERSION_KEY, dependencies.texlive.release);

  const processJob = async (job: Job, token?: string): Promise<CompileResult> => {
    const parsed = compileJob.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError(failureReasons.invalidJob);
    const data = parsed.data;
    const lock = compileLockKey(data.projectId);
    // One compilation per project at a time, whichever worker holds the job.
    if ((await redis.set(lock, data.compileId, 'PX', lockTtlMs, 'NX')) === null) {
      await job.moveToDelayed(Date.now() + LOCK_RETRY_MS, token);
      throw new DelayedError();
    }
    const controller = new AbortController();
    running.set(data.compileId, controller);
    try {
      // A cancellation published before this worker listened is still on record.
      if ((await redis.exists(compileCancelKey(data.compileId))) === 1) controller.abort();
      const local = await compile(data, environment, controller.signal);
      const outputs: CompileOutput[] = [];
      if (local.result.outcome !== 'cancelled') {
        for (const file of local.publishable) {
          const opened = await openSandboxFile(join(local.dirs.out, file.name));
          if (!opened) continue;
          await dependencies.publish(data.compileId, file.name, opened.stream, opened.size);
          outputs.push({ name: file.name, size: opened.size });
        }
      }
      await recordSize(local.dirs.root);
      durations.observe({ engine: data.engine }, local.result.durationMs / 1000);
      logger.info(
        {
          compileId: data.compileId,
          projectId: data.projectId,
          outcome: local.result.outcome,
          durationMs: local.result.durationMs,
          exitCode: local.run.exitCode,
        },
        'compilation finished',
      );
      return { ...local.result, outputs };
    } finally {
      running.delete(data.compileId);
      await redis.eval(RELEASE_LOCK, 1, lock, data.compileId);
      await enforceQuota(
        config.COMPILER_WORK_DIR,
        config.COMPILER_WORK_QUOTA_MB * 1024 * 1024,
        async (projectId) => (await redis.exists(compileLockKey(projectId))) === 1,
      ).catch((error: unknown) => {
        logger.warn({ err: error }, 'work directory eviction failed');
      });
    }
  };

  // BullMQ workers block on Valkey and require unlimited retries per request.
  const worker = new Worker<unknown, CompileResult>(COMPILE_QUEUE, processJob, {
    connection: { url: config.VALKEY_URL, maxRetriesPerRequest: null },
    concurrency: config.COMPILER_CONCURRENCY,
    // A compilation can legitimately keep the event loop busy while it reads a large log.
    lockDuration: 60_000,
  });
  worker.on('completed', (_job, result) => {
    jobs.inc({ outcome: result.outcome });
  });
  worker.on('failed', (job, error) => {
    jobs.inc({ outcome: 'error' });
    logger.warn({ jobId: job?.id, reason: error.message }, 'compile job failed');
  });
  worker.on('error', (error) => {
    logger.error({ err: error }, 'worker error');
  });

  const probeServer = createProbeServer({
    live: () => ({ status: 'ok', service: 'compiler', version }),
    ready: async () => {
      const { status, checks } = await runHealthChecks({
        valkey: () => redis.ping(),
        worker: () =>
          worker.isRunning() ? Promise.resolve() : Promise.reject(new Error('worker stopped')),
      });
      return { status, service: 'compiler', version, checks };
    },
    metrics: async () => [registry.contentType, await registry.metrics()],
  });

  return {
    worker,
    probeServer,
    async close() {
      await new Promise<void>((resolve) =>
        probeServer.close(() => {
          resolve();
        }),
      );
      for (const controller of running.values()) controller.abort();
      await worker.close();
      subscriber.disconnect();
      redis.disconnect();
    },
  };
}
