import {
  ApiError,
  type CompareResponse,
  compareResponse,
  createVersionRequest,
  type HistoryResponse,
  MAX_TEXT_BYTES,
  projectPath,
  restoreRequest,
  type RestoreResponse,
  type SnapshotFilesResponse,
  updateSnapshotRequest,
} from '@galley/shared';
import { blobs, snapshots } from '@galley/db';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/mini';
import { requireAuth } from '../auth/plugin.js';
import type { AppContext } from '../context.js';
import { hasTextName } from '../files/classify.js';
import { applyState } from '../history/apply.js';
import { type ProjectState } from '../history/state.js';
import {
  latestSnapshot,
  recordActivity,
  type SnapshotRow,
  summarize,
  takeSnapshot,
} from '../history/snapshots.js';
import { parse } from '../http/validate.js';
import { materializeProject } from '../materialize.js';
import { writeArchive } from '../archive/write.js';
import { loadProject } from '../projects/access.js';
import { publishProjectEvent } from '../projects/events.js';
import { readBlob } from '../storage/blobs.js';
import { sendUserFile } from './files.js';
import { projectParams } from './projects.js';

const PAGE_SIZE = 50;

/** A version of the project: a snapshot, or `current` for the live state. */
const versionRef = z.union([z.uuid(), z.literal('current')]);
const versionParams = z.object({ id: z.uuid(), version: versionRef });
const snapshotParams = z.object({ id: z.uuid(), snapshotId: z.uuid() });
const historyQuery = z.object({ before: z.optional(z.iso.datetime({ offset: true })) });
const contentQuery = z.object({ path: projectPath });
const compareQuery = z.object({ from: z.uuid(), to: z.optional(versionRef) });

/**
 * History of a project (SPEC §3.5): snapshots, comparison, contents of a
 * version, archives, named versions and restoration.
 */
export function historyRoutes(app: FastifyInstance, context: AppContext): void {
  const { database, redis, s3, config } = context;
  const { db } = database;

  async function snapshotOf(projectId: string, snapshotId: string): Promise<SnapshotRow> {
    const [row] = await db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.id, snapshotId), eq(snapshots.projectId, projectId)));
    if (!row) throw new ApiError('NOT_FOUND');
    return row;
  }

  async function stateOf(projectId: string, version: string): Promise<ProjectState> {
    if (version === 'current') return materializeProject(context, projectId);
    const row = await snapshotOf(projectId, version);
    return { manifest: row.manifest, folders: row.folders };
  }

  app.get('/api/projects/:id/history', async (request): Promise<HistoryResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { before } = parse(historyQuery, request.query);
    await loadProject(db, id, auth.user.id, 'reader');
    const rows = await db
      .select()
      .from(snapshots)
      .where(
        and(
          eq(snapshots.projectId, id),
          before === undefined ? undefined : lt(snapshots.createdAt, new Date(before)),
        ),
      )
      .orderBy(desc(snapshots.createdAt))
      .limit(PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    return {
      snapshots: await summarize(db, page),
      nextCursor: rows.length > PAGE_SIZE ? (page.at(-1)?.createdAt.toISOString() ?? null) : null,
    };
  });

  app.post('/api/projects/:id/history', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { label } = parse(createVersionRequest, request.body);
    await loadProject(db, id, auth.user.id, 'editor');
    const row = await takeSnapshot(context, id, 'named', { label, always: true });
    if (!row) throw new ApiError('INTERNAL_ERROR');
    const [summary] = await summarize(db, [row]);
    return reply.status(201).send({ snapshot: summary });
  });

  app.patch('/api/projects/:id/history/:snapshotId', async (request) => {
    const auth = requireAuth(request);
    const { id, snapshotId } = parse(snapshotParams, request.params);
    const { label } = parse(updateSnapshotRequest, request.body);
    await loadProject(db, id, auth.user.id, 'editor');
    const [row] = await db
      .update(snapshots)
      .set({ label })
      .where(and(eq(snapshots.id, snapshotId), eq(snapshots.projectId, id)))
      .returning();
    if (!row) throw new ApiError('NOT_FOUND');
    await publishProjectEvent(redis, id, { type: 'history.changed' });
    const [summary] = await summarize(db, [row]);
    return { snapshot: summary };
  });

  app.get(
    '/api/projects/:id/history/:version/files',
    async (request): Promise<SnapshotFilesResponse> => {
      const auth = requireAuth(request);
      const { id, version } = parse(versionParams, request.params);
      await loadProject(db, id, auth.user.id, 'reader');
      const { manifest, folders } = await stateOf(id, version);
      return {
        files: Object.entries(manifest)
          .map(([path, hash]) => ({ path, hash }))
          .sort((a, b) => (a.path < b.path ? -1 : 1)),
        folders,
      };
    },
  );

  app.get('/api/projects/:id/history/:version/content', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, version } = parse(versionParams, request.params);
    const { path } = parse(contentQuery, request.query);
    await loadProject(db, id, auth.user.id, 'reader');
    const hash = (await stateOf(id, version)).manifest[path];
    if (hash === undefined) throw new ApiError('NOT_FOUND');
    const name = path.split('/').at(-1) ?? path;
    // A version's content never changes; the live state does.
    const cache = version === 'current' ? 'private, no-cache' : 'private, max-age=86400, immutable';
    return sendUserFile(reply, name, await readBlob(s3, config.S3_BUCKET, hash), cache);
  });

  app.get('/api/projects/:id/history/compare', async (request): Promise<CompareResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { from, to = 'current' } = parse(compareQuery, request.query);
    await loadProject(db, id, auth.user.id, 'reader');
    const [before, after] = [await stateOf(id, from), await stateOf(id, to)];
    const paths = [...new Set([...Object.keys(before.manifest), ...Object.keys(after.manifest)])]
      .filter((path) => before.manifest[path] !== after.manifest[path])
      .sort();
    const hashes = paths.flatMap((path) =>
      [before.manifest[path], after.manifest[path]].filter((hash) => hash !== undefined),
    );
    const sizes = new Map(
      (hashes.length
        ? await db
            .select({ hash: blobs.hash, size: blobs.size })
            .from(blobs)
            .where(inArray(blobs.hash, [...new Set(hashes)]))
        : []
      ).map((row) => [row.hash, row.size]),
    );
    const small = (hash: string | undefined) =>
      hash === undefined || (sizes.get(hash) ?? Infinity) <= MAX_TEXT_BYTES;
    return compareResponse.parse({
      changes: paths.map((path) => {
        const fromHash = before.manifest[path] ?? null;
        const toHash = after.manifest[path] ?? null;
        return {
          path,
          status: fromHash === null ? 'added' : toHash === null ? 'removed' : 'modified',
          from: fromHash,
          to: toHash,
          text: hasTextName(path) && small(fromHash ?? undefined) && small(toHash ?? undefined),
        };
      }),
    });
  });

  app.get('/api/projects/:id/history/:snapshotId/archive', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, snapshotId } = parse(snapshotParams, request.params);
    const { project } = await loadProject(db, id, auth.user.id, 'reader');
    const row = await snapshotOf(id, snapshotId);
    const stream = writeArchive(
      { manifest: row.manifest, folders: row.folders, paths: new Map() },
      (hash) => readBlob(s3, config.S3_BUCKET, hash),
    );
    const date = row.createdAt.toISOString().slice(0, 16).replace(':', 'h');
    return reply
      .header('content-type', 'application/zip')
      .header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`${project.name} ${date}.zip`)}`,
      )
      .header('cache-control', 'no-store')
      .send(stream);
  });

  app.post(
    '/api/projects/:id/history/:snapshotId/restore',
    async (request): Promise<RestoreResponse> => {
      const auth = requireAuth(request);
      const { id, snapshotId } = parse(snapshotParams, request.params);
      const { path } = parse(restoreRequest, request.body ?? {});
      await loadProject(db, id, auth.user.id, 'editor');
      const version = await snapshotOf(id, snapshotId);
      // The state being replaced goes into the history first, so nothing is lost.
      const current = await materializeProject(context, id);
      await takeSnapshot(context, id, 'auto', { state: current });

      let target: ProjectState = { manifest: version.manifest, folders: version.folders };
      if (path !== undefined) {
        const hash = version.manifest[path];
        if (hash === undefined) throw new ApiError('NOT_FOUND', 'no such file in this version');
        target = { manifest: { ...current.manifest, [path]: hash }, folders: current.folders };
      }
      const changes = await applyState(context, id, target);
      await recordActivity(db, id, auth.user.id);
      const changed =
        changes.written.length + changes.removedFiles.length + changes.removedFolders.length > 0;
      // Restoring the state the project already had changes nothing and records nothing.
      // Otherwise the restoration is always listed, even when a periodic snapshot taken
      // in between already holds the same state.
      const row =
        (await takeSnapshot(context, id, 'restore', {
          authorIds: [auth.user.id],
          always: changed,
        })) ?? (await latestSnapshot(db, id));
      if (!row) throw new ApiError('INTERNAL_ERROR');
      const [summary] = await summarize(db, [row]);
      if (!summary) throw new ApiError('INTERNAL_ERROR');
      return { snapshot: summary };
    },
  );
}
