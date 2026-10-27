import { type SnapshotKind, type SnapshotSummary } from '@galley/shared';
import { type Executor, projectActivity, projects, snapshots, users } from '@galley/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { materializeProject } from '../materialize.js';
import { publishProjectEvent } from '../projects/events.js';
import { type ProjectState, stateDigest } from './state.js';

export type SnapshotRow = typeof snapshots.$inferSelect;

/** Minimum time between two automatic snapshots of a project with activity. */
export const AUTO_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const LOCK_MS = 60_000;

/** Records that `userId` changed the project, for the authors of its next snapshot. */
export async function recordActivity(
  db: Executor,
  projectId: string,
  userId: string,
): Promise<void> {
  await db.insert(projectActivity).values({ projectId, userId }).onConflictDoNothing();
}

/** The project's most recent snapshot, if any. */
export async function latestSnapshot(
  db: Executor,
  projectId: string,
): Promise<SnapshotRow | undefined> {
  const [row] = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.projectId, projectId))
    .orderBy(desc(snapshots.createdAt))
    .limit(1);
  return row;
}

export interface SnapshotOptions {
  label?: string;
  /** Records the state even when it equals the last snapshot (named versions). */
  always?: boolean;
  /** State already read by the caller; read from the project otherwise. */
  state?: ProjectState;
  /** Authors to add to those recorded since the last snapshot. */
  authorIds?: readonly string[];
}

/**
 * Records the project's current state in its history, unless it equals the
 * last snapshot. The authors are the users recorded since the last snapshot,
 * whose list is emptied in the same transaction.
 *
 * Snapshots of one project are serialised by a Valkey lock; a concurrent call
 * waits for it rather than producing a duplicate.
 *
 * @returns the new snapshot, or `null` when nothing changed.
 */
export async function takeSnapshot(
  context: AppContext,
  projectId: string,
  kind: SnapshotKind,
  options: SnapshotOptions = {},
): Promise<SnapshotRow | null> {
  const { database, redis } = context;
  const lock = `history:lock:${projectId}`;
  const owner = crypto.randomUUID();
  const deadline = Date.now() + LOCK_MS;
  while ((await redis.set(lock, owner, 'PX', LOCK_MS, 'NX')) !== 'OK') {
    if (Date.now() > deadline) throw new Error(`history lock of ${projectId} not released`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    const state = options.state ?? (await materializeProject(context, projectId));
    const digest = stateDigest(state);
    const row = await database.db.transaction(async (tx) => {
      const previous = await latestSnapshot(tx, projectId);
      if (!options.always && previous?.digest === digest) return null;
      const authors = await tx
        .delete(projectActivity)
        .where(eq(projectActivity.projectId, projectId))
        .returning({ userId: projectActivity.userId });
      const authorIds = [
        ...new Set([...authors.map((author) => author.userId), ...(options.authorIds ?? [])]),
      ];
      const [created] = await tx
        .insert(snapshots)
        .values({
          projectId,
          kind,
          label: options.label ?? null,
          authorIds,
          manifest: state.manifest,
          folders: state.folders,
          digest,
        })
        .returning();
      return created ?? null;
    });
    if (row) await publishProjectEvent(redis, projectId, { type: 'history.changed' });
    return row;
  } finally {
    // Release only our own lock, in case it expired and someone else took it.
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
      1,
      lock,
      owner,
    );
  }
}

/**
 * Takes the automatic snapshots that are due: projects with recorded activity
 * whose last snapshot is older than {@link AUTO_SNAPSHOT_INTERVAL_MS}.
 *
 * @returns how many snapshots were taken.
 */
export async function takeDueSnapshots(context: AppContext, now: Date): Promise<number> {
  const { db } = context.database;
  const cutoff = new Date(now.getTime() - AUTO_SNAPSHOT_INTERVAL_MS);
  const due = await db
    .selectDistinct({ projectId: projectActivity.projectId })
    .from(projectActivity)
    .innerJoin(projects, eq(projects.id, projectActivity.projectId))
    .where(
      and(
        isNull(projects.deletedAt),
        sql`not exists (select 1 from ${snapshots} s where s.project_id = ${projectActivity.projectId} and s.created_at > ${cutoff.toISOString()})`,
      ),
    );
  let taken = 0;
  for (const { projectId } of due) {
    if (await takeSnapshot(context, projectId, 'auto')) taken += 1;
  }
  return taken;
}

/**
 * Applies the retention rule of SPEC §6.7: every snapshot for 30 days, then
 * the last one of each hour until 90 days, then the last one of each day.
 * Named versions are kept forever.
 *
 * @returns how many snapshots were deleted.
 */
export async function pruneSnapshots(db: Executor, now: Date): Promise<number> {
  const day = 86_400_000;
  const thirty = new Date(now.getTime() - 30 * day);
  const ninety = new Date(now.getTime() - 90 * day);
  let deleted = 0;
  for (const { bucket, from, to } of [
    { bucket: 'hour', from: ninety, to: thirty },
    { bucket: 'day', from: new Date(0), to: ninety },
  ]) {
    const rows = await db.execute<{ id: string }>(sql`
      delete from ${snapshots} where id in (
        select id from (
          select id, row_number() over (
            partition by project_id, date_trunc(${bucket}, created_at)
            order by created_at desc
          ) as rank
          from ${snapshots}
          where label is null and created_at >= ${from.toISOString()} and created_at < ${to.toISOString()}
        ) ranked where rank > 1
      ) returning id`);
    deleted += rows.length;
  }
  return deleted;
}

/** Turns snapshot rows into the API's summaries, with their authors' names. */
export async function summarize(
  db: Executor,
  rows: readonly SnapshotRow[],
): Promise<SnapshotSummary[]> {
  const ids = [...new Set(rows.flatMap((row) => row.authorIds))];
  const names = ids.length
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  const byId = new Map(names.map((user) => [user.id, user]));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    authors: row.authorIds.flatMap((id) => {
      const user = byId.get(id);
      return user ? [user] : [];
    }),
    fileCount: Object.keys(row.manifest).length,
  }));
}
