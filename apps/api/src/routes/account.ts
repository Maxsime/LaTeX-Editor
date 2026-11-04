import { sessions, users } from '@galley/db';
import { type AccountSessionsResponse, ApiError, changePasswordRequest } from '@galley/shared';
import { and, asc, eq, gt, ne } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as z from 'zod/mini';
import { clearSessionCookie, requireAuth } from '../auth/plugin.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { publicOrigin } from '../auth/oidc.js';
import type { AppContext } from '../context.js';
import { parse } from '../http/validate.js';
import { passwordChangedMail } from '../mail/messages.js';

const sessionParams = z.object({ id: z.uuid() });

/**
 * Guesses of the current password are counted per account, whatever the
 * address: someone holding a stolen session must not be able to try
 * passwords until one works and lock the owner out.
 */
const passwordRateLimit = {
  rateLimit: {
    max: 10,
    timeWindow: '15 minutes',
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest): string =>
      `password:${request.auth?.user.id ?? request.ip}`,
  },
};

/** The user's own credentials and signed-in browsers, in « Mon compte ». */
export function accountRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context.database;

  /**
   * Changes the password after checking the current one, then closes every
   * other session of the account: whoever knew the old password, or held a
   * session opened with it, is signed out. The owner is told by e-mail.
   */
  app.post('/api/me/password', { config: passwordRateLimit }, async (request, reply) => {
    const auth = requireAuth(request);
    const { currentPassword, newPassword } = parse(changePasswordRequest, request.body);
    const [user] = await db
      .select({ passwordHash: users.passwordHash, email: users.email })
      .from(users)
      .where(eq(users.id, auth.user.id))
      .limit(1);
    if (!user) throw new ApiError('UNAUTHENTICATED');
    // An account created through the identity provider signs in there; giving it a
    // password here would let a stolen session outlive the provider's controls.
    if (user.passwordHash === null) throw new ApiError('PASSWORD_NOT_SET');
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new ApiError('PASSWORD_INCORRECT');
    }
    const passwordHash = await hashPassword(newPassword);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, auth.user.id));
      await tx
        .delete(sessions)
        .where(and(eq(sessions.userId, auth.user.id), ne(sessions.id, auth.sessionId)));
    });
    request.log.info({ userId: auth.user.id }, 'password changed');
    if (context.mailer !== undefined) {
      context.mailer
        .send(
          passwordChangedMail({
            to: user.email,
            displayName: auth.user.displayName,
            link: `${publicOrigin(context.config)}/forgot-password`,
          }),
        )
        .catch((error: unknown) => {
          request.log.error({ err: error, userId: auth.user.id }, 'password change notice failed');
        });
    }
    return reply.status(204).send();
  });

  app.get('/api/me/sessions', async (request): Promise<AccountSessionsResponse> => {
    const auth = requireAuth(request);
    const rows = await db
      .select({
        id: sessions.id,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, auth.user.id), gt(sessions.expiresAt, new Date())))
      .orderBy(asc(sessions.createdAt));
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        current: row.id === auth.sessionId,
      })),
    };
  });

  /** Signs out one browser of the account; the current one signs out like a logout. */
  app.delete('/api/me/sessions/:id', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(sessionParams, request.params);
    const deleted = await db
      .delete(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, auth.user.id)))
      .returning({ id: sessions.id });
    if (deleted.length === 0) throw new ApiError('NOT_FOUND');
    if (id === auth.sessionId) clearSessionCookie(reply);
    request.log.info({ userId: auth.user.id }, 'session revoked');
    return reply.status(204).send();
  });

  /** Signs out every browser of the account but this one. */
  app.delete('/api/me/sessions', async (request, reply) => {
    const auth = requireAuth(request);
    await db
      .delete(sessions)
      .where(and(eq(sessions.userId, auth.user.id), ne(sessions.id, auth.sessionId)));
    request.log.info({ userId: auth.user.id }, 'other sessions revoked');
    return reply.status(204).send();
  });
}
