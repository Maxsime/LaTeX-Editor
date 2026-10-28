import { compileRuns, type Executor, files, projects, userQuotas } from '@galley/db';
import { ApiError, type InstanceQuotas, type QuotaUsage } from '@galley/shared';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

const MB = 1024 * 1024;

/** Limits that apply to one person, in bytes and seconds; null is unlimited. */
export interface Limits {
  storageBytes: number | null;
  compileSeconds: number | null;
}

/**
 * Combines the instance defaults with a person's own values: null follows the
 * default, -1 lifts the limit.
 */
export function limitsOf(
  defaults: InstanceQuotas,
  own: { storageMb: number | null; compileMinutes: number | null } | undefined,
): Limits {
  const pick = (value: number | null | undefined, fallback: number | null) => {
    if (value === -1) return null;
    return value ?? fallback;
  };
  const storageMb = pick(own?.storageMb, defaults.storageMb);
  const compileMinutes = pick(own?.compileMinutes, defaults.compileMinutes);
  return {
    storageBytes: storageMb === null ? null : storageMb * MB,
    compileSeconds: compileMinutes === null ? null : compileMinutes * 60,
  };
}

/** First instant of the calendar month (UTC) that compile time is counted over. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** A person's limits as stored for them and by the instance. */
export async function limitsFor(
  db: Executor,
  defaults: InstanceQuotas,
  userId: string,
): Promise<Limits> {
  const [own] = await db.select().from(userQuotas).where(eq(userQuotas.userId, userId));
  return limitsOf(defaults, own);
}

/**
 * Bytes of every project a person owns, trash included until the purge:
 * binary sizes and the last written size of each text file.
 */
export async function storageUsed(db: Executor, ownerId: string): Promise<number> {
  const [row] = await db
    .select({ bytes: sql<string | null>`sum(${files.size})` })
    .from(files)
    .innerJoin(projects, eq(projects.id, files.projectId))
    .where(eq(projects.ownerId, ownerId));
  return Number(row?.bytes ?? 0);
}

/** Seconds of compilation a person started since `since`, finished runs only. */
export async function compileSecondsUsed(
  db: Executor,
  userId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({
      seconds: sql<
        string | null
      >`sum(extract(epoch from (${compileRuns.finishedAt} - ${compileRuns.startedAt})))`,
    })
    .from(compileRuns)
    .where(
      and(
        eq(compileRuns.userId, userId),
        gte(compileRuns.startedAt, since),
        isNotNull(compileRuns.finishedAt),
      ),
    );
  return Math.round(Number(row?.seconds ?? 0));
}

/** Assistant previews have no compile run: their time is counted here, per person and month. */
function snippetKey(userId: string, since: Date): string {
  return `galley:quota:snippets:${userId}:${since.toISOString().slice(0, 7)}`;
}

/** Adds the duration of an assistant preview to its requester's month. */
export async function recordSnippetTime(
  redis: Redis,
  userId: string,
  seconds: number,
  now = new Date(),
): Promise<void> {
  const key = snippetKey(userId, monthStart(now));
  await redis.incrbyfloat(key, seconds);
  // Kept a little beyond the month, then forgotten.
  await redis.expire(key, 40 * 86_400);
}

/** Seconds of compilation of the month: project compilations and assistant previews. */
export async function monthCompileSeconds(
  db: Executor,
  redis: Redis,
  userId: string,
  now = new Date(),
): Promise<number> {
  const since = monthStart(now);
  const snippets = Number((await redis.get(snippetKey(userId, since))) ?? 0);
  return (await compileSecondsUsed(db, userId, since)) + Math.round(snippets);
}

async function ownerOf(db: Executor, projectId: string): Promise<string> {
  const [row] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!row) throw new ApiError('NOT_FOUND');
  return row.ownerId;
}

/**
 * Guards a write that may add data to a project. Usage is measured before and
 * after the write, inside the caller's transaction: the write is refused when
 * it grows the owner's usage beyond the limit, so that shrinking or deleting
 * stays possible for someone already over it.
 */
export async function storageGuard(
  db: Executor,
  defaults: InstanceQuotas,
  projectId: string,
): Promise<{ check: () => Promise<void> }> {
  const ownerId = await ownerOf(db, projectId);
  const { storageBytes } = await limitsFor(db, defaults, ownerId);
  if (storageBytes === null) return { check: () => Promise.resolve() };
  const before = await storageUsed(db, ownerId);
  return {
    check: async () => {
      const after = await storageUsed(db, ownerId);
      if (after > before && after > storageBytes) throw new ApiError('QUOTA_STORAGE_EXCEEDED');
    },
  };
}

/**
 * Refuses an upload before it is stored when the owner is already beyond the
 * limit or would be by `incomingBytes`, counting replaced files as new: the
 * exact check follows in {@link storageGuard}.
 */
export async function assertRoomFor(
  db: Executor,
  defaults: InstanceQuotas,
  projectId: string,
  incomingBytes: number,
): Promise<void> {
  const ownerId = await ownerOf(db, projectId);
  const { storageBytes } = await limitsFor(db, defaults, ownerId);
  if (storageBytes === null) return;
  const used = await storageUsed(db, ownerId);
  if (used >= storageBytes && incomingBytes > 0) throw new ApiError('QUOTA_STORAGE_EXCEEDED');
}

/** Refuses new content of `incomingBytes` for a person's new project when it does not fit. */
export async function assertOwnerRoom(
  db: Executor,
  defaults: InstanceQuotas,
  ownerId: string,
  incomingBytes: number,
): Promise<void> {
  const { storageBytes } = await limitsFor(db, defaults, ownerId);
  if (storageBytes === null || incomingBytes === 0) return;
  if ((await storageUsed(db, ownerId)) + incomingBytes > storageBytes) {
    throw new ApiError('QUOTA_STORAGE_EXCEEDED');
  }
}

/**
 * Whether a project may be replaced by content of `newBytes` in all (a Git
 * push): refused when it grows the project and the owner goes beyond the limit.
 */
export async function fitsAfterResize(
  db: Executor,
  defaults: InstanceQuotas,
  projectId: string,
  newBytes: number,
): Promise<boolean> {
  const ownerId = await ownerOf(db, projectId);
  const { storageBytes } = await limitsFor(db, defaults, ownerId);
  if (storageBytes === null) return true;
  const [row] = await db
    .select({ bytes: sql<string | null>`sum(${files.size})` })
    .from(files)
    .where(eq(files.projectId, projectId));
  const current = Number(row?.bytes ?? 0);
  if (newBytes <= current) return true;
  return (await storageUsed(db, ownerId)) - current + newBytes <= storageBytes;
}

/** Refuses to start a compilation once the person's monthly time is used up. */
export async function assertCompileTime(
  db: Executor,
  redis: Redis,
  defaults: InstanceQuotas,
  userId: string,
  now = new Date(),
): Promise<void> {
  const { compileSeconds } = await limitsFor(db, defaults, userId);
  if (compileSeconds === null) return;
  const used = await monthCompileSeconds(db, redis, userId, now);
  if (used >= compileSeconds) throw new ApiError('QUOTA_COMPILE_EXCEEDED');
}

/** What a person used of their quotas, for « Mon compte » and the console. */
export async function quotaUsageOf(
  db: Executor,
  redis: Redis,
  defaults: InstanceQuotas,
  userId: string,
  now = new Date(),
): Promise<QuotaUsage> {
  const limits = await limitsFor(db, defaults, userId);
  const since = monthStart(now);
  return {
    storage: { usedBytes: await storageUsed(db, userId), limitBytes: limits.storageBytes },
    compile: {
      usedSeconds: await monthCompileSeconds(db, redis, userId, now),
      limitSeconds: limits.compileSeconds,
      since: since.toISOString(),
    },
  };
}
