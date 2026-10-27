import {
  type AccessTokensResponse,
  createAccessTokenRequest,
  type CreatedAccessToken,
} from '@galley/shared';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/mini';
import { createAccessToken, listAccessTokens, revokeAccessToken } from '../auth/access-tokens.js';
import { requireAuth } from '../auth/plugin.js';
import type { AppContext } from '../context.js';
import { parse } from '../http/validate.js';

const tokenParams = z.object({ id: z.uuid() });

/** Personal access tokens, used as passwords by Git clients (SPEC §3.6). */
export function tokenRoutes(app: FastifyInstance, { database }: AppContext): void {
  const { db } = database;

  app.get('/api/tokens', async (request): Promise<AccessTokensResponse> => {
    const auth = requireAuth(request);
    return { tokens: await listAccessTokens(db, auth.user.id) };
  });

  app.post('/api/tokens', async (request, reply) => {
    const auth = requireAuth(request);
    const { name, expiresInDays } = parse(createAccessTokenRequest, request.body);
    const created: CreatedAccessToken = await createAccessToken(
      db,
      auth.user.id,
      name,
      expiresInDays,
    );
    return reply.status(201).header('cache-control', 'no-store').send(created);
  });

  app.delete('/api/tokens/:id', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(tokenParams, request.params);
    await revokeAccessToken(db, auth.user.id, id);
    return reply.status(204).send();
  });
}
