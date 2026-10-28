import {
  ApiError,
  copyFilesRequest,
  createLinkedFileRequest,
  duplicateProjectRequest,
  saveTemplateRequest,
  type TemplateSummary,
  type TexmfResponse,
  updateTemplateRequest,
} from '@galley/shared';
import { templates, users } from '@galley/db';
import { asc, count, eq, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/mini';
import { requireAuth } from '../auth/plugin.js';
import type { AppContext } from '../context.js';
import { toTreeNode } from '../files/tree.js';
import { recordActivity } from '../history/snapshots.js';
import { parse } from '../http/validate.js';
import { createLinkedFile, linkLabels, refreshLinkedFile, unlinkFile } from '../links/service.js';
import { materializeProject } from '../materialize.js';
import { loadProject } from '../projects/access.js';
import { copyFiles, duplicateProject } from '../projects/copy.js';
import { publishProjectEvent } from '../projects/events.js';
import { toSummary } from '../projects/service.js';
import { ensureTexmfProject, requireDocument } from '../projects/texmf.js';
import { projectParams } from './projects.js';

/** Personal templates a person may keep; templates are never counted in quotas. */
const MAX_TEMPLATES_PER_USER = 50;

const templateParams = z.object({ id: z.uuid() });
const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() });

/**
 * Duplication, copies between projects, templates, the personal texmf tree
 * and linked files (SPEC §3.1).
 */
export function libraryRoutes(app: FastifyInstance, context: AppContext): void {
  const { database, redis } = context;
  const { db } = database;

  async function treeChanged(projectId: string, userId: string): Promise<void> {
    await recordActivity(db, projectId, userId);
    await publishProjectEvent(redis, projectId, { type: 'tree.changed' });
  }

  app.post('/api/projects/:id/duplicate', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { name } = parse(duplicateProjectRequest, request.body);
    const { project } = await loadProject(db, id, auth.user.id, 'reader');
    requireDocument(project);
    const copy = await duplicateProject(context, project, auth.user.id, name);
    return reply.status(201).send({ project: toSummary(copy, 'owner', auth.user.displayName, []) });
  });

  app.post('/api/projects/:id/files/copy', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const body = parse(copyFilesRequest, request.body);
    await loadProject(db, id, auth.user.id, 'editor');
    await loadProject(db, body.sourceProjectId, auth.user.id, 'reader');
    if (body.sourceProjectId === id) {
      throw new ApiError('BAD_REQUEST', 'copy within a project is not supported');
    }
    await copyFiles(context, body.sourceProjectId, id, body);
    await treeChanged(id, auth.user.id);
    return reply.status(204).send();
  });

  // --- Templates ------------------------------------------------------------------

  app.get('/api/templates', async (request): Promise<{ templates: TemplateSummary[] }> => {
    const auth = requireAuth(request);
    const rows = await db
      .select({ template: templates, ownerName: users.displayName })
      .from(templates)
      .innerJoin(users, eq(users.id, templates.ownerId))
      .where(or(eq(templates.ownerId, auth.user.id), eq(templates.visibility, 'instance')))
      .orderBy(asc(templates.name));
    return {
      templates: rows.map(({ template, ownerName }) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        visibility: template.visibility,
        ownerName,
        mine: template.ownerId === auth.user.id,
        files: Object.keys(template.manifest).length,
        engine: template.engine,
        createdAt: template.createdAt.toISOString(),
      })),
    };
  });

  app.post('/api/projects/:id/template', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const body = parse(saveTemplateRequest, request.body);
    const { project } = await loadProject(db, id, auth.user.id, 'reader');
    requireDocument(project);
    if (body.visibility === 'instance' && !auth.user.isAdmin) throw new ApiError('FORBIDDEN');
    const [owned] = await db
      .select({ total: count() })
      .from(templates)
      .where(eq(templates.ownerId, auth.user.id));
    if ((owned?.total ?? 0) >= MAX_TEMPLATES_PER_USER) {
      throw new ApiError('CONFLICT', 'too many templates');
    }
    const snapshot = await materializeProject(context, id);
    const [row] = await db
      .insert(templates)
      .values({
        ownerId: auth.user.id,
        visibility: body.visibility,
        name: body.name,
        description: body.description,
        manifest: snapshot.manifest,
        folders: snapshot.folders,
        mainPath:
          project.mainFileId === null ? null : (snapshot.paths.get(project.mainFileId) ?? null),
        engine: project.engine,
        bibTool: project.bibTool,
      })
      .returning({ id: templates.id });
    return reply.status(201).send({ id: row?.id });
  });

  /** Owners change their templates; administrators also those of the instance. */
  async function editableTemplate(templateId: string, userId: string, isAdmin: boolean) {
    const [row] = await db.select().from(templates).where(eq(templates.id, templateId));
    const visible = row !== undefined && (row.ownerId === userId || row.visibility === 'instance');
    if (!visible) throw new ApiError('NOT_FOUND');
    if (row.ownerId !== userId && !isAdmin) throw new ApiError('FORBIDDEN');
    return row;
  }

  app.patch('/api/templates/:id', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(templateParams, request.params);
    const body = parse(updateTemplateRequest, request.body);
    await editableTemplate(id, auth.user.id, auth.user.isAdmin);
    if (body.visibility === 'instance' && !auth.user.isAdmin) throw new ApiError('FORBIDDEN');
    await db
      .update(templates)
      .set({
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
      })
      .where(eq(templates.id, id));
    return reply.status(204).send();
  });

  app.delete('/api/templates/:id', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(templateParams, request.params);
    await editableTemplate(id, auth.user.id, auth.user.isAdmin);
    await db.delete(templates).where(eq(templates.id, id));
    return reply.status(204).send();
  });

  // --- Personal texmf -------------------------------------------------------------

  app.get('/api/me/texmf', async (request): Promise<TexmfResponse> => {
    const auth = requireAuth(request);
    const project = await ensureTexmfProject(db, auth.user.id);
    return { projectId: project.id };
  });

  // --- Linked files ---------------------------------------------------------------

  app.post('/api/projects/:id/files/link', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const body = parse(createLinkedFileRequest, request.body);
    await loadProject(db, id, auth.user.id, 'editor');
    const row = await createLinkedFile(context, auth.user.id, id, body);
    await treeChanged(id, auth.user.id);
    const labels = await linkLabels(db, auth.user.id, [row]);
    return reply.status(201).send({ node: toTreeNode(row, labels.get(row.id)) });
  });

  app.post('/api/projects/:id/files/:fileId/refresh', async (request) => {
    const auth = requireAuth(request);
    const { id, fileId } = parse(fileParams, request.params);
    await loadProject(db, id, auth.user.id, 'editor');
    const row = await refreshLinkedFile(context, auth.user.id, id, fileId);
    await treeChanged(id, auth.user.id);
    const labels = await linkLabels(db, auth.user.id, [row]);
    return { node: toTreeNode(row, labels.get(row.id)) };
  });

  app.post('/api/projects/:id/files/:fileId/unlink', async (request) => {
    const auth = requireAuth(request);
    const { id, fileId } = parse(fileParams, request.params);
    await loadProject(db, id, auth.user.id, 'editor');
    const row = await unlinkFile(context, id, fileId);
    await publishProjectEvent(redis, id, { type: 'tree.changed' });
    return { node: toTreeNode(row) };
  });
}
