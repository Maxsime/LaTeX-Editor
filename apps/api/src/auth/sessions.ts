import type { PublicUser } from '@galley/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { randomToken, tokenDigest } from './tokens.js';

export interface AuthenticatedSession {
  sessionId: string;
  csrfToken: string;
  user: PublicUser;
}

/** Creates a session and returns the cookie token, which is not stored anywhere. */
export async function createSession(
  { db }: Database,
  userId: string,
  ttlDays: number,
  userAgent: string | undefined,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  await db.insert(sessions).values({
    userId,
    tokenHash: tokenDigest(token),
    csrfToken: randomToken(),
    expiresAt,
    userAgent: userAgent?.slice(0, 300) ?? null,
  });
  return { token, expiresAt };
}

/**
 * Resolves a cookie token to its session and user. Expired sessions and
 * disabled accounts resolve to `null`. The expiry slides forward at most once
 * an hour, to avoid a write on every request.
 */
export async function findSession(
  { db }: Database,
  token: string,
  ttlDays: number,
): Promise<AuthenticatedSession | null> {
  const now = new Date();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      csrfToken: sessions.csrfToken,
      lastSeenAt: sessions.lastSeenAt,
      id: users.id,
      email: users.email,
      username: users.username,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenDigest(token)),
        gt(sessions.expiresAt, now),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  if (!row) return null;

  if (now.getTime() - row.lastSeenAt.getTime() > 3_600_000) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + ttlDays * 86_400_000) })
      .where(eq(sessions.id, row.sessionId));
  }
  return {
    sessionId: row.sessionId,
    csrfToken: row.csrfToken,
    user: {
      id: row.id,
      email: row.email,
      username: row.username,
      displayName: row.displayName,
      isAdmin: row.isAdmin,
    },
  };
}

export async function deleteSession({ db }: Database, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Signs a user out everywhere, e.g. after an administrator resets the password. */
export async function deleteUserSessions({ db }: Database, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
