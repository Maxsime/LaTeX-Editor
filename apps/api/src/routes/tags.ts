import { ApiError, type Tag, tagRequest } from '@galley/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/mini';
import { requireAuth } from '../auth/plugin.js';
import type { AppContext } from '../context.js';
import { uniqueViolation } from '../db/errors.js';
import { projectTags, tags } from '../db/schema.js';
import { parse } from '../http/validate.js';
import { loadProject } from '../projects/access.js';

const tagParams = z.object({ id: z.uuid() });
const projectTagParams = z.object({ id: z.uuid(), tagId: z.uuid() });

function toTag(row: typeof tags.$inferSelect): Tag {
  return { id: row.id, name: row.name, color: row.color };
}

function conflictOnDuplicate(error: unknown): never {
  if (uniqueViolation(error)) throw new ApiError('CONFLICT', 'tag name already used');
  throw error;
}

/** Tags are personal: each user sees and applies only their own. */
export function tagRoutes(app: FastifyInstance, { database }: AppContext): void {
  const { db } = database;

  async function ownTag(userId: string, tagId: string): Promise<void> {
    const [row] = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.id, tagId), eq(tags.userId, userId)));
    if (!row) throw new ApiError('NOT_FOUND');
  }

  app.get('/api/tags', async (request): Promise<{ tags: Tag[] }> => {
    const auth = requireAuth(request);
    const rows = await db
      .select()
      .from(tags)
      .where(eq(tags.userId, auth.user.id))
      .orderBy(asc(tags.name));
    return { tags: rows.map(toTag) };
  });

  app.post('/api/tags', async (request, reply) => {
    const auth = requireAuth(request);
    const body = parse(tagRequest, request.body);
    const [row] = await db
      .insert(tags)
      .values({ userId: auth.user.id, name: body.name.trim(), color: body.color })
      .returning()
      .catch(conflictOnDuplicate);
    if (!row) throw new ApiError('INTERNAL_ERROR');
    return reply.status(201).send({ tag: toTag(row) });
  });

  app.patch('/api/tags/:id', async (request) => {
    const auth = requireAuth(request);
    const { id } = parse(tagParams, request.params);
    const body = parse(tagRequest, request.body);
    const [row] = await db
      .update(tags)
      .set({ name: body.name.trim(), color: body.color })
      .where(and(eq(tags.id, id), eq(tags.userId, auth.user.id)))
      .returning()
      .catch(conflictOnDuplicate);
    if (!row) throw new ApiError('NOT_FOUND');
    return { tag: toTag(row) };
  });

  app.delete('/api/tags/:id', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(tagParams, request.params);
    const deleted = await db
      .delete(tags)
      .where(and(eq(tags.id, id), eq(tags.userId, auth.user.id)))
      .returning({ id: tags.id });
    if (deleted.length === 0) throw new ApiError('NOT_FOUND');
    return reply.status(204).send();
  });

  app.put('/api/projects/:id/tags/:tagId', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, tagId } = parse(projectTagParams, request.params);
    await loadProject(db, id, auth.user.id, 'reader', { trashed: true });
    await ownTag(auth.user.id, tagId);
    await db.insert(projectTags).values({ projectId: id, tagId }).onConflictDoNothing();
    return reply.status(204).send();
  });

  app.delete('/api/projects/:id/tags/:tagId', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, tagId } = parse(projectTagParams, request.params);
    await loadProject(db, id, auth.user.id, 'reader', { trashed: true });
    await ownTag(auth.user.id, tagId);
    await db
      .delete(projectTags)
      .where(and(eq(projectTags.projectId, id), eq(projectTags.tagId, tagId)));
    return reply.status(204).send();
  });
}
