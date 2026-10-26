import { ApiError, createInviteRequest, type CreatedInvite, type Invite } from '@galley/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/mini';
import { requireAdmin } from '../auth/plugin.js';
import { randomToken, tokenDigest } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { registrationInvites } from '../db/schema.js';
import { parse } from '../http/validate.js';

const idParams = z.object({ id: z.uuid() });

function toInvite(row: typeof registrationInvites.$inferSelect): Invite {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
  };
}

/** Instance-level administration. Every route requires an administrator. */
export function adminRoutes(app: FastifyInstance, { database }: AppContext): void {
  const { db } = database;

  app.get('/api/admin/invites', async (request): Promise<{ invites: Invite[] }> => {
    requireAdmin(request);
    const rows = await db
      .select()
      .from(registrationInvites)
      .orderBy(desc(registrationInvites.createdAt))
      .limit(200);
    return { invites: rows.map(toInvite) };
  });

  app.post('/api/admin/invites', async (request, reply) => {
    const auth = requireAdmin(request);
    const body = parse(createInviteRequest, request.body ?? {});
    const token = randomToken();
    const [row] = await db
      .insert(registrationInvites)
      .values({
        tokenHash: tokenDigest(token),
        createdBy: auth.user.id,
        expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000),
      })
      .returning();
    if (!row) throw new ApiError('INTERNAL_ERROR');
    const created: CreatedInvite = { invite: toInvite(row), token };
    return reply.status(201).send(created);
  });

  app.delete('/api/admin/invites/:id', async (request, reply) => {
    requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const deleted = await db
      .delete(registrationInvites)
      .where(eq(registrationInvites.id, id))
      .returning({ id: registrationInvites.id });
    if (deleted.length === 0) throw new ApiError('NOT_FOUND');
    return reply.status(204).send();
  });
}
