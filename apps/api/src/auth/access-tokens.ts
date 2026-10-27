import { ACCESS_TOKEN_PREFIX, type AccessToken, ApiError } from '@galley/shared';
import { type Executor, personalAccessTokens, users } from '@galley/db';
import { and, count, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { randomToken, tokenDigest } from './tokens.js';

/** Live tokens a user may hold; more would only hide forgotten ones. */
export const MAX_ACCESS_TOKENS = 20;
/** `last_used_at` is refreshed at most this often, not on every Git request. */
const LAST_USED_RESOLUTION_MS = 60_000;

type TokenRow = typeof personalAccessTokens.$inferSelect;

function toAccessToken(row: TokenRow): AccessToken {
  return {
    id: row.id,
    name: row.name,
    hint: row.hint,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

const live = (now: Date) =>
  and(
    isNull(personalAccessTokens.revokedAt),
    or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, now)),
  );

/** The user's tokens that still work, newest first. */
export async function listAccessTokens(db: Executor, userId: string): Promise<AccessToken[]> {
  const rows = await db
    .select()
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.userId, userId), live(new Date())))
    .orderBy(desc(personalAccessTokens.createdAt));
  return rows.map(toAccessToken);
}

/**
 * Creates a token. Only its digest is stored: the secret is returned here and
 * can never be read again.
 */
export async function createAccessToken(
  db: Executor,
  userId: string,
  name: string,
  expiresInDays: number | undefined,
): Promise<{ token: string; accessToken: AccessToken }> {
  const now = new Date();
  const [held] = await db
    .select({ value: count() })
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.userId, userId), live(now)));
  if ((held?.value ?? 0) >= MAX_ACCESS_TOKENS) {
    throw new ApiError('CONFLICT', 'too many access tokens');
  }
  const token = `${ACCESS_TOKEN_PREFIX}${randomToken()}`;
  const [row] = await db
    .insert(personalAccessTokens)
    .values({
      userId,
      name,
      tokenHash: tokenDigest(token),
      hint: token.slice(-4),
      expiresAt:
        expiresInDays === undefined ? null : new Date(now.getTime() + expiresInDays * 86_400_000),
    })
    .returning();
  if (!row) throw new ApiError('INTERNAL_ERROR');
  return { token, accessToken: toAccessToken(row) };
}

/** Revokes one of the user's tokens; someone else's is reported missing. */
export async function revokeAccessToken(db: Executor, userId: string, id: string): Promise<void> {
  const [row] = await db
    .update(personalAccessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(personalAccessTokens.id, id),
        eq(personalAccessTokens.userId, userId),
        isNull(personalAccessTokens.revokedAt),
      ),
    )
    .returning({ id: personalAccessTokens.id });
  if (!row) throw new ApiError('NOT_FOUND');
}

/**
 * The user a token authenticates: live token, active account.
 *
 * @returns the user's id, or `null` for any token that does not work.
 */
export async function authenticateAccessToken(
  db: Executor,
  token: string,
  now = new Date(),
): Promise<{ userId: string; tokenId: string } | null> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  const [row] = await db
    .select({ id: personalAccessTokens.id, userId: personalAccessTokens.userId })
    .from(personalAccessTokens)
    .innerJoin(users, eq(users.id, personalAccessTokens.userId))
    .where(
      and(
        eq(personalAccessTokens.tokenHash, tokenDigest(token)),
        live(now),
        isNull(users.disabledAt),
      ),
    );
  if (!row) return null;
  await db
    .update(personalAccessTokens)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(personalAccessTokens.id, row.id),
        or(
          isNull(personalAccessTokens.lastUsedAt),
          lt(personalAccessTokens.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS)),
        ),
      ),
    );
  return { userId: row.userId, tokenId: row.id };
}
