import { COMPILE_QUEUE, compileJob, runHealthChecks } from '@galley/shared';
import { createProbeServer, type Logger } from '@galley/shared/node';
import { type Job, UnrecoverableError, Worker } from 'bullmq';
import type { Server } from 'node:http';
import { Redis } from 'ioredis';
import { collectDefaultMetrics, Counter, Registry } from 'prom-client';
import type { CompilerConfig } from './config.js';

/** Failure reasons recorded on jobs; the API maps them to user-facing messages. */
export const failureReasons = {
  invalidJob: 'INVALID_JOB',
  notImplemented: 'NOT_IMPLEMENTED',
} as const;

/**
 * Validates a compile job. Compilation itself arrives in J3; until then every
 * valid job fails without retry so that nothing piles up in the queue.
 */
export function processCompileJob(job: Pick<Job, 'data'>): Promise<void> {
  const parsed = compileJob.safeParse(job.data);
  if (!parsed.success) {
    return Promise.reject(new UnrecoverableError(failureReasons.invalidJob));
  }
  return Promise.reject(new UnrecoverableError(failureReasons.notImplemented));
}

export interface CompilerService {
  worker: Worker<unknown, void>;
  probeServer: Server;
  close(): Promise<void>;
}

/** Starts the queue consumer and the probe server. */
export function createCompilerService(
  config: CompilerConfig,
  logger: Logger,
  version: string,
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

  // BullMQ workers block on Valkey and require unlimited retries per request.
  const worker = new Worker<unknown, void>(COMPILE_QUEUE, processCompileJob, {
    connection: { url: config.VALKEY_URL, maxRetriesPerRequest: null },
    concurrency: config.COMPILER_CONCURRENCY,
  });
  worker.on('completed', () => {
    jobs.inc({ outcome: 'completed' });
  });
  worker.on('failed', (job, error) => {
    jobs.inc({ outcome: 'failed' });
    logger.warn({ jobId: job?.id, reason: error.message }, 'compile job failed');
  });
  worker.on('error', (error) => {
    logger.error({ err: error }, 'worker error');
  });

  const probeRedis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1 });
  const probeServer = createProbeServer({
    live: () => ({ status: 'ok', service: 'compiler', version }),
    ready: async () => {
      const { status, checks } = await runHealthChecks({
        valkey: () => probeRedis.ping(),
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
      await worker.close();
      probeRedis.disconnect();
    },
  };
}
