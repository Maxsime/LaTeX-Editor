import { TRASH_RETENTION_DAYS } from '@galley/shared';
import { Queue, Worker } from 'bullmq';
import { and, isNotNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { type Executor, projects } from '@galley/db';
import type { AppContext } from '../context.js';
import { pruneSnapshots, takeDueSnapshots } from '../history/snapshots.js';

/** Queue for periodic API housekeeping. */
export const MAINTENANCE_QUEUE = 'maintenance';
const PURGE_JOB = 'purge-trash';
const SNAPSHOT_JOB = 'take-snapshots';
const PRUNE_JOB = 'prune-snapshots';

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
 * Schedules the periodic jobs: trash purge every hour, automatic snapshots
 * every minute, snapshot retention every day. The schedulers are idempotent,
 * so every API instance may call this; BullMQ runs each occurrence once.
 */
export async function startMaintenance(
  context: AppContext,
  connection: Redis,
  logger: FastifyBaseLogger,
): Promise<() => Promise<void>> {
  const { db } = context.database;
  const queue = new Queue(MAINTENANCE_QUEUE, { connection });
  await queue.upsertJobScheduler(PURGE_JOB, { every: 3_600_000 }, { name: PURGE_JOB });
  await queue.upsertJobScheduler(SNAPSHOT_JOB, { every: 60_000 }, { name: SNAPSHOT_JOB });
  await queue.upsertJobScheduler(PRUNE_JOB, { every: 86_400_000 }, { name: PRUNE_JOB });
  const worker = new Worker<unknown, void>(
    MAINTENANCE_QUEUE,
    async (job) => {
      const now = new Date();
      if (job.name === PURGE_JOB) {
        const count = await purgeTrash(db, now);
        if (count > 0) logger.info({ count }, 'trashed projects purged');
      } else if (job.name === SNAPSHOT_JOB) {
        const count = await takeDueSnapshots(context, now);
        if (count > 0) logger.debug({ count }, 'automatic snapshots taken');
      } else if (job.name === PRUNE_JOB) {
        const count = await pruneSnapshots(db, now);
        if (count > 0) logger.info({ count }, 'old snapshots pruned');
      }
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
