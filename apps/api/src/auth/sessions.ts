import type { PublicUser } from '@galley/shared';
import { eq } from 'drizzle-orm';
import { type Database, findSessionByToken, sessions, tokenDigest } from '@galley/db';
import { randomToken } from './tokens.js';

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
  const found = await findSessionByToken(db, token, now);
  if (!found) return null;

  if (now.getTime() - found.lastSeenAt.getTime() > 3_600_000) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + ttlDays * 86_400_000) })
      .where(eq(sessions.id, found.sessionId));
  }
  return { sessionId: found.sessionId, csrfToken: found.csrfToken, user: found.user };
}

export async function deleteSession({ db }: Database, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Signs a user out everywhere, e.g. after an administrator resets the password. */
export async function deleteUserSessions({ db }: Database, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
