import { createHash } from 'node:crypto';
import type { PublicUser } from '@galley/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Executor } from './client.js';
import { sessions, users } from './schema.js';

/** Digest stored in place of a token, so a database leak does not leak live tokens. */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A live session with its user, as stored. */
export interface SessionRecord {
  sessionId: string;
  csrfToken: string;
  lastSeenAt: Date;
  user: PublicUser;
}

/**
 * Resolves a session cookie token. Expired sessions and disabled accounts
 * resolve to `null`. Read-only: callers decide whether to extend the session.
 */
export async function findSessionByToken(
  db: Executor,
  token: string,
  now = new Date(),
): Promise<SessionRecord | null> {
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
  return {
    sessionId: row.sessionId,
    csrfToken: row.csrfToken,
    lastSeenAt: row.lastSeenAt,
    user: {
      id: row.id,
      email: row.email,
      username: row.username,
      displayName: row.displayName,
      isAdmin: row.isAdmin,
    },
  };
}
