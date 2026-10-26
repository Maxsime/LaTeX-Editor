import type { Readable } from 'node:stream';
import {
  ApiError,
  createFolderRequest,
  type ImportWarning,
  MAX_UPLOAD_BYTES,
  type ProjectTree,
  splitProjectPath,
  updateFileRequest,
  type UploadResponse,
} from '@galley/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as z from 'zod/mini';
import { requireAuth } from '../auth/plugin.js';
import type { AppContext } from '../context.js';
import { yjsStates } from '@galley/db';
import { classifySpooled, type IncomingFile, mimeTypeFor } from '../files/ingest.js';
import { createScratchDir, spool } from '../files/spool.js';
import {
  assertFolder,
  createFolder,
  deleteNode,
  ensureMainFile,
  getNode,
  listNodes,
  toTreeNode,
  touchProject,
  updateNode,
  writeFiles,
} from '../files/tree.js';
import { parse } from '../http/validate.js';
import { loadProject } from '../projects/access.js';
import { publishProjectEvent } from '../projects/events.js';
import { readBlob, storeBlobs } from '../storage/blobs.js';
import { stateToText, textBytes } from '../yjs/text.js';
import { projectParams } from './projects.js';

const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() });

/** Files at most this many per upload request; folders dropped in the browser can be large. */
const MAX_FILES_PER_UPLOAD = 1000;

/** Types a browser may render inline without risk; everything else is downloaded. */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

/**
 * User files share the application's origin, so they must never run as a
 * page: unknown types are downloaded, and inline ones get a sandbox policy.
 * PDF viewers do not work under `sandbox`, but they do not run page scripts.
 */
function sendUserFile(reply: FastifyReply, name: string, body: Buffer | Readable): FastifyReply {
  const mimeType = mimeTypeFor(name);
  const inline = INLINE_TYPES.has(mimeType) || mimeType.startsWith('text/');
  void reply
    .header('content-type', mimeType.startsWith('text/') ? `${mimeType}; charset=utf-8` : mimeType)
    .header('x-content-type-options', 'nosniff')
    .header(
      'content-security-policy',
      mimeType === 'application/pdf'
        ? "default-src 'none'; frame-ancestors 'none'"
        : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'",
    )
    .header(
      'content-disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    )
    .header('cache-control', 'private, no-cache');
  return reply.send(body);
}

export function fileRoutes(app: FastifyInstance, context: AppContext): void {
  const { database, redis, s3, config } = context;
  const { db } = database;

  async function treeChanged(projectId: string): Promise<void> {
    await touchProject(db, projectId);
    await publishProjectEvent(redis, projectId, { type: 'tree.changed' });
  }

  app.get('/api/projects/:id/tree', async (request): Promise<ProjectTree> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { project } = await loadProject(db, id, auth.user.id, 'reader');
    const rows = await listNodes(db, id);
    return { mainFileId: project.mainFileId, nodes: rows.map(toTreeNode) };
  });

  app.post('/api/projects/:id/folders', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const body = parse(createFolderRequest, request.body);
    await loadProject(db, id, auth.user.id, 'editor');
    await assertFolder(db, id, body.parentId);
    const row = await createFolder(db, id, body.parentId, body.name);
    await treeChanged(id);
    return reply.status(201).send({ node: toTreeNode(row) });
  });

  /**
   * Multipart upload of one or more files. An optional `parentId` field comes
   * first; each file part may be preceded by a `path` field giving its
   * location below the parent (for dropped folders), else its file name is used.
   */
  app.post('/api/projects/:id/files', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    await loadProject(db, id, auth.user.id, 'editor');
    if (!request.isMultipart()) throw new ApiError('BAD_REQUEST', 'multipart expected');

    const scratch = await createScratchDir(config.API_TMP_DIR);
    try {
      const warnings: ImportWarning[] = [];
      const incoming: IncomingFile[] = [];
      let parentId: string | null = null;
      let pendingPath: string | undefined;
      for await (const part of request.parts({
        limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_UPLOAD, fieldSize: 4096 },
      })) {
        if (part.type === 'field') {
          const value = typeof part.value === 'string' ? part.value : '';
          if (part.fieldname === 'parentId') {
            if (incoming.length > 0) throw new ApiError('BAD_REQUEST', 'parentId must come first');
            parentId = parse(z.nullable(z.uuid()), value === '' ? null : value);
          } else if (part.fieldname === 'path') {
            pendingPath = value;
          }
          continue;
        }
        const segments = splitProjectPath(pendingPath ?? part.filename);
        pendingPath = undefined;
        if (segments === null) {
          part.file.resume();
          throw new ApiError('VALIDATION_FAILED', 'invalid file path');
        }
        const target = scratch.file('upload');
        const spooled = await spool(part.file, target, MAX_UPLOAD_BYTES);
        if (part.file.truncated) throw new ApiError('PAYLOAD_TOO_LARGE');
        incoming.push(await classifySpooled(segments, { path: target, ...spooled }, warnings));
      }
      if (incoming.length === 0) throw new ApiError('BAD_REQUEST', 'no file');

      await assertFolder(db, id, parentId);
      await storeBlobs(
        db,
        s3,
        config.S3_BUCKET,
        incoming.flatMap((file) => (file.kind === 'binary' ? [file.blob] : [])),
      );
      const nodes = await db.transaction(async (tx) => {
        const before = new Set((await listNodes(tx, id)).map((row) => row.id));
        const written = await writeFiles(tx, id, parentId, incoming);
        await ensureMainFile(tx, id);
        // Report created folders too, so the client can update its tree in one go.
        const writtenIds = new Set(written.map((row) => row.id));
        const created = (await listNodes(tx, id)).filter(
          (row) => !before.has(row.id) && !writtenIds.has(row.id),
        );
        return [...created, ...written];
      });
      await treeChanged(id);
      const response: UploadResponse = { nodes: nodes.map(toTreeNode), warnings };
      void reply.status(201);
      return response;
    } finally {
      await scratch.cleanup();
    }
  });

  app.patch('/api/projects/:id/files/:fileId', async (request) => {
    const auth = requireAuth(request);
    const { id, fileId } = parse(fileParams, request.params);
    const body = parse(updateFileRequest, request.body);
    await loadProject(db, id, auth.user.id, 'editor');
    const row = await updateNode(db, id, fileId, body);
    await treeChanged(id);
    return { node: toTreeNode(row) };
  });

  app.delete('/api/projects/:id/files/:fileId', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, fileId } = parse(fileParams, request.params);
    await loadProject(db, id, auth.user.id, 'editor');
    await deleteNode(db, id, fileId);
    await treeChanged(id);
    return reply.status(204).send();
  });

  app.get('/api/projects/:id/files/:fileId/content', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, fileId } = parse(fileParams, request.params);
    await loadProject(db, id, auth.user.id, 'reader');
    const node = await getNode(db, id, fileId);
    if (node.kind === 'folder') throw new ApiError('BAD_REQUEST', 'folders have no content');
    if (node.kind === 'text') {
      const [row] = await db.select().from(yjsStates).where(eq(yjsStates.fileId, node.id));
      const bytes = textBytes(row ? stateToText(row.state) : '');
      return sendUserFile(reply, node.name, Buffer.from(bytes));
    }
    if (node.blobHash === null) throw new ApiError('NOT_FOUND');
    return sendUserFile(reply, node.name, await readBlob(s3, config.S3_BUCKET, node.blobHash));
  });
}
