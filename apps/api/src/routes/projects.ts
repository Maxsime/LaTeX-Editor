import {
  ApiError,
  createProjectRequest,
  listProjectsQuery,
  type ProjectDetails,
  type ProjectSummary,
  splitProjectPath,
  updateProjectRequest,
} from '@galley/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/mini';
import { requireAuth } from '../auth/plugin.js';
import { assertOwnerRoom } from '../admin/quotas.js';
import { instanceSettingsOf } from '../admin/settings.js';
import type { AppContext } from '../context.js';
import { projects } from '@galley/db';
import { getNode, writeFiles } from '../files/tree.js';
import { parse } from '../http/validate.js';
import { loadProject } from '../projects/access.js';
import { publishProjectEvent } from '../projects/events.js';
import { insertProject, listProjects, projectDetails, toSummary } from '../projects/service.js';
import { templates } from '../projects/templates.js';
import { textBytes } from '../yjs/text.js';
import { unknownKeyTokens } from '../bibliography/keys.js';

export const projectParams = z.object({ id: z.uuid() });

export function projectRoutes(app: FastifyInstance, context: AppContext): void {
  const { database, redis } = context;
  const { db } = database;

  app.get('/api/projects', async (request): Promise<{ projects: ProjectSummary[] }> => {
    const auth = requireAuth(request);
    const query = parse(listProjectsQuery, request.query);
    return { projects: await listProjects(db, auth.user.id, query) };
  });

  app.post('/api/projects', async (request, reply) => {
    const auth = requireAuth(request);
    const body = parse(createProjectRequest, request.body);
    const { quotas } = await instanceSettingsOf(context).get();
    const project = await db.transaction(async (tx) => {
      const row = await insertProject(tx, auth.user.id, body.name);
      const files = templates[body.template].map((file) => {
        const segments = splitProjectPath(file.path);
        if (!segments) throw new ApiError('INTERNAL_ERROR');
        return {
          segments,
          kind: 'text' as const,
          content: file.content,
          size: textBytes(file.content).length,
        };
      });
      await assertOwnerRoom(
        tx,
        quotas,
        auth.user.id,
        files.reduce((total, file) => total + file.size, 0),
      );
      const {
        rows: [main],
      } = await writeFiles(tx, row.id, null, files);
      const [updated] = await tx
        .update(projects)
        .set({ mainFileId: main?.id ?? null })
        .where(eq(projects.id, row.id))
        .returning();
      return updated ?? row;
    });
    return reply.status(201).send({
      project: toSummary(project, 'owner', auth.user.displayName, []),
    });
  });

  app.get('/api/projects/:id', async (request): Promise<ProjectDetails> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { project, role } = await loadProject(db, id, auth.user.id, 'reader', { trashed: true });
    return projectDetails(db, auth.user.id, project, role);
  });

  app.patch('/api/projects/:id', async (request): Promise<ProjectDetails> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const body = parse(updateProjectRequest, request.body);
    const access = await loadProject(
      db,
      id,
      auth.user.id,
      body.name === undefined && body.trackChanges === undefined && body.aiEnabled === undefined
        ? 'editor'
        : 'owner',
    );
    if (body.citeKeyPattern !== undefined && unknownKeyTokens(body.citeKeyPattern).length > 0) {
      throw new ApiError('VALIDATION_FAILED', 'unknown key pattern token');
    }
    if (body.mainFileId !== undefined && body.mainFileId !== null) {
      const node = await getNode(db, id, body.mainFileId);
      if (node.kind !== 'text') throw new ApiError('BAD_REQUEST', 'main file must be a text file');
    }
    const [row] = await db
      .update(projects)
      .set({
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.mainFileId === undefined ? {} : { mainFileId: body.mainFileId }),
        ...(body.engine === undefined ? {} : { engine: body.engine }),
        ...(body.bibTool === undefined ? {} : { bibTool: body.bibTool }),
        ...(body.shellEscape === undefined ? {} : { shellEscape: body.shellEscape }),
        ...(body.trackChanges === undefined ? {} : { trackChanges: body.trackChanges }),
        ...(body.aiEnabled === undefined ? {} : { aiEnabled: body.aiEnabled }),
        ...(body.citeKeyPattern === undefined ? {} : { citeKeyPattern: body.citeKeyPattern }),
        ...(body.spellLanguage === undefined ? {} : { spellLanguage: body.spellLanguage }),
        ...(body.chktexDisabled === undefined
          ? {}
          : { chktexDisabled: [...new Set(body.chktexDisabled)].sort((a, b) => a - b) }),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning();
    if (!row) throw new ApiError('NOT_FOUND');
    await publishProjectEvent(redis, id, { type: 'project.updated' });
    return projectDetails(db, auth.user.id, row, access.role);
  });

  /** Owner-only state changes: archive, unarchive, trash and restore. */
  function stateRoute(
    path: string,
    method: 'POST' | 'DELETE',
    change: (now: Date) => Partial<typeof projects.$inferInsert>,
    options: { trashed?: boolean } = {},
  ): void {
    app.route({
      method,
      url: path,
      handler: async (request, reply) => {
        const auth = requireAuth(request);
        const { id } = parse(projectParams, request.params);
        await loadProject(db, id, auth.user.id, 'owner', options);
        await db.update(projects).set(change(new Date())).where(eq(projects.id, id));
        await publishProjectEvent(redis, id, { type: 'project.updated' });
        return reply.status(204).send();
      },
    });
  }
  stateRoute('/api/projects/:id/archive', 'POST', (now) => ({ archivedAt: now }));
  stateRoute('/api/projects/:id/unarchive', 'POST', () => ({ archivedAt: null }));
  stateRoute('/api/projects/:id', 'DELETE', (now) => ({ deletedAt: now }));
  stateRoute('/api/projects/:id/restore', 'POST', () => ({ deletedAt: null }), { trashed: true });

  /** Permanent deletion from the trash, before the automatic purge. */
  app.delete('/api/projects/:id/permanent', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { project } = await loadProject(db, id, auth.user.id, 'owner', { trashed: true });
    if (project.deletedAt === null) throw new ApiError('CONFLICT', 'project is not in the trash');
    await db.delete(projects).where(eq(projects.id, id));
    await publishProjectEvent(redis, id, { type: 'project.deleted' });
    return reply.status(204).send();
  });
}
