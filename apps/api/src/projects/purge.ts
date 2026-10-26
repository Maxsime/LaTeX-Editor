import { TRASH_RETENTION_DAYS } from '@galley/shared';
import { Queue, Worker } from 'bullmq';
import { and, isNotNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { type Executor, projects } from '@galley/db';

/** Queue for periodic API housekeeping. */
export const MAINTENANCE_QUEUE = 'maintenance';
const PURGE_JOB = 'purge-trash';

/** Deletes projects trashed more than {@link TRASH_RETENTION_DAYS} days before `now`. */
export async function purgeTrash(db: Executor, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 86_400_000);
  const deleted = await db
    .delete(projects)
    .where(and(isNotNull(projects.deletedAt), lt(projects.deletedAt, cutoff)))
    .returning({ id: projects.id });
  return deleted.length;
}

/**
 * Schedules the trash purge every hour. The scheduler is idempotent, so every
 * API instance may call this; BullMQ runs each occurrence once.
 */
export async function startMaintenance(
  db: Executor,
  connection: Redis,
  logger: FastifyBaseLogger,
): Promise<() => Promise<void>> {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection });
  await queue.upsertJobScheduler(PURGE_JOB, { every: 3_600_000 }, { name: PURGE_JOB });
  const worker = new Worker<unknown, void>(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name !== PURGE_JOB) return;
      const count = await purgeTrash(db, new Date());
      if (count > 0) logger.info({ count }, 'trashed projects purged');
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, error) => {
    logger.error({ err: error, job: job?.name }, 'maintenance job failed');
  });
  return async () => {
    await worker.close();
    await queue.close();
  };
}
