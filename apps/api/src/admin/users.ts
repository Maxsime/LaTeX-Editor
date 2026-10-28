import {
  compileRuns,
  type Executor,
  files,
  projects,
  sessions,
  userIdentities,
  userQuotas,
  users,
} from '@galley/db';
import { ADMIN_USERS_PAGE, type AdminUser, ApiError } from '@galley/shared';
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { randomToken } from '../auth/tokens.js';
import { monthStart } from './quotas.js';

/** Long enough to be safe, short enough to type once before changing it. */
export function temporaryPassword(): string {
  return randomToken(15);
}

/** Escapes the wildcards of a LIKE pattern, so that a search is literal. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * One page of accounts for the console, with what each uses. Usage is read in
 * grouped queries over the page only, not per account.
 */
export async function listAdminUsers(
  db: Executor,
  query: { q?: string | undefined; offset: number },
  now = new Date(),
): Promise<{ users: AdminUser[]; total: number }> {
  const search = query.q?.trim();
  const filter =
    search === undefined || search === ''
      ? undefined
      : or(
          ilike(users.email, likePattern(search)),
          ilike(users.username, likePattern(search)),
          ilike(users.displayName, likePattern(search)),
        );
  const [counted] = await db.select({ value: count() }).from(users).where(filter);
  const rows = await db
    .select()
    .from(users)
    .where(filter)
    .orderBy(desc(users.createdAt), users.id)
    .limit(ADMIN_USERS_PAGE)
    .offset(query.offset);
  return { users: await describeUsers(db, rows, now), total: counted?.value ?? 0 };
}

/** The console's view of the given accounts. */
export async function describeUsers(
  db: Executor,
  rows: readonly (typeof users.$inferSelect)[],
  now = new Date(),
): Promise<AdminUser[]> {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const storage = await db
    .select({ id: projects.ownerId, bytes: sql<string | null>`sum(${files.size})` })
    .from(files)
    .innerJoin(projects, eq(projects.id, files.projectId))
    .where(inArray(projects.ownerId, ids))
    .groupBy(projects.ownerId);
  const compile = await db
    .select({
      id: compileRuns.userId,
      seconds: sql<
        string | null
      >`sum(extract(epoch from (${compileRuns.finishedAt} - ${compileRuns.startedAt})))`,
    })
    .from(compileRuns)
    .where(
      and(
        inArray(compileRuns.userId, ids),
        gte(compileRuns.startedAt, monthStart(now)),
        isNotNull(compileRuns.finishedAt),
      ),
    )
    .groupBy(compileRuns.userId);
  const seen = await db
    .select({ id: sessions.userId, at: sql<Date | null>`max(${sessions.lastSeenAt})` })
    .from(sessions)
    .where(inArray(sessions.userId, ids))
    .groupBy(sessions.userId);
  const identities = await db
    .selectDistinct({ id: userIdentities.userId })
    .from(userIdentities)
    .where(inArray(userIdentities.userId, ids));
  const quotas = await db.select().from(userQuotas).where(inArray(userQuotas.userId, ids));

  const storageOf = new Map(storage.map((row) => [row.id, Number(row.bytes ?? 0)]));
  const compileOf = new Map(compile.map((row) => [row.id, Math.round(Number(row.seconds ?? 0))]));
  const seenOf = new Map(seen.map((row) => [row.id, row.at]));
  const oidc = new Set(identities.map((row) => row.id));
  const quotaOf = new Map(quotas.map((row) => [row.userId, row]));
  return rows.map((row) => {
    const lastSeen = seenOf.get(row.id);
    const quota = quotaOf.get(row.id);
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      displayName: row.displayName,
      isAdmin: row.isAdmin,
      disabled: row.disabledAt !== null,
      hasPassword: row.passwordHash !== null,
      oidc: oidc.has(row.id),
      createdAt: row.createdAt.toISOString(),
      // The driver returns aggregates of timestamps as text.
      lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
      storageBytes: storageOf.get(row.id) ?? 0,
      compileSecondsThisMonth: compileOf.get(row.id) ?? 0,
      quotas: {
        storageMb: quota?.storageMb ?? null,
        compileMinutes: quota?.compileMinutes ?? null,
      },
    };
  });
}

/** Loads one account for the console, or NOT_FOUND. */
export async function adminUserById(db: Executor, id: string): Promise<AdminUser> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  if (!row) throw new ApiError('NOT_FOUND');
  const [described] = await describeUsers(db, [row]);
  if (!described) throw new ApiError('INTERNAL_ERROR');
  return described;
}

/** Arbitrary constant serialising changes of administrators across API instances. */
const ADMINS_LOCK_KEY = 7_265_830_143;

/**
 * Refuses a change that would leave no active administrator: `userId` is about
 * to lose its rights or be disabled. Takes a lock held until the transaction ends.
 */
export async function assertAnotherAdmin(tx: Executor, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADMINS_LOCK_KEY})`);
  const [others] = await tx
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.isAdmin, true), isNull(users.disabledAt), ne(users.id, userId)));
  if ((others?.value ?? 0) === 0) throw new ApiError('LAST_ADMIN');
}
