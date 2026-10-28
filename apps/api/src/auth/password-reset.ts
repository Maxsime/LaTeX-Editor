import { type Database, passwordResets, users } from '@galley/db';
import { ApiError, PASSWORD_RESET_TTL_MINUTES } from '@galley/shared';
import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Mailer } from '../mail/mailer.js';
import { passwordResetMail } from '../mail/messages.js';
import { hashPassword } from './password.js';
import { deleteUserSessions } from './sessions.js';
import { randomToken, tokenDigest } from './tokens.js';

/** Page of the web application that reads the token from its query string. */
export const RESET_PAGE = '/reset-password';

/**
 * Sends a reset link to the account registered under `email`, if there is
 * one: active and with a password of its own (an account created through the
 * identity provider signs in there). Earlier unused links of that account stop
 * working, so only the latest message counts.
 *
 * @returns whether a message was queued, for tests; callers must not tell.
 */
export async function requestPasswordReset(
  database: Database,
  mailer: Mailer,
  origin: string,
  email: string,
  now: Date,
): Promise<boolean> {
  const { db } = database;
  const [user] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.email, email), isNull(users.disabledAt), isNotNull(users.passwordHash)))
    .limit(1);
  if (!user) return false;
  const token = randomToken();
  await db.transaction(async (tx) => {
    await tx
      .delete(passwordResets)
      .where(
        or(
          and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)),
          lt(passwordResets.expiresAt, now),
        ),
      );
    await tx.insert(passwordResets).values({
      userId: user.id,
      tokenHash: tokenDigest(token),
      expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000),
    });
  });
  await mailer.send(
    passwordResetMail({
      to: user.email,
      displayName: user.displayName,
      link: `${origin}${RESET_PAGE}?token=${encodeURIComponent(token)}`,
    }),
  );
  return true;
}

/**
 * Sets a new password with a reset token: valid, unexpired and unused. The
 * token is spent in the same transaction, and every session of the account is
 * closed, so that whoever held the old password is signed out.
 *
 * @throws {ApiError} `RESET_TOKEN_INVALID` otherwise.
 */
export async function confirmPasswordReset(
  database: Database,
  token: string,
  password: string,
  now: Date,
): Promise<string> {
  const passwordHash = await hashPassword(password);
  const userId = await database.db.transaction(async (tx) => {
    const [reset] = await tx
      .select({ id: passwordResets.id, userId: passwordResets.userId })
      .from(passwordResets)
      .innerJoin(users, eq(users.id, passwordResets.userId))
      .where(
        and(
          eq(passwordResets.tokenHash, tokenDigest(token)),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, now),
          isNull(users.disabledAt),
        ),
      )
      .for('update', { of: passwordResets });
    if (!reset) throw new ApiError('RESET_TOKEN_INVALID');
    await tx.update(passwordResets).set({ usedAt: now }).where(eq(passwordResets.id, reset.id));
    await tx.update(users).set({ passwordHash }).where(eq(users.id, reset.userId));
    return reset.userId;
  });
  await deleteUserSessions(database, userId);
  return userId;
}
