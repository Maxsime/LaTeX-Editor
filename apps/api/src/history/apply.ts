import { ApiError, splitProjectPath } from '@galley/shared';
import { blobs } from '@galley/db';
import { inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { decodeText } from '../files/classify.js';
import type { IncomingFile } from '../files/ingest.js';
import {
  deleteNode,
  ensureMainFile,
  listNodes,
  nodePaths,
  touchProject,
  writeFiles,
} from '../files/tree.js';
import { materializeProject } from '../materialize.js';
import { publishProjectEvent } from '../projects/events.js';
import { readBlobBytes } from '../storage/blobs.js';
import { diffStates, type ProjectState, type StateChanges } from './state.js';

function segmentsOf(path: string): string[] {
  const segments = splitProjectPath(path);
  // States come from snapshots and checked Git trees, whose paths were validated.
  if (segments === null) throw new ApiError('VALIDATION_FAILED', 'invalid path in state');
  return segments;
}

/**
 * Makes a project's files match `target`, as one transaction on the tree.
 * Text files that stay text are replaced through collab, so that open editors
 * show the new content at once; the rest is created, replaced or deleted in
 * the tree. Contents are read from stored blobs, which every state refers to.
 *
 * @returns what changed; nothing when the project already matched.
 */
export async function applyState(
  context: AppContext,
  projectId: string,
  target: ProjectState,
): Promise<StateChanges> {
  const { database, s3, config, documents, redis } = context;
  const { db } = database;
  const current = await materializeProject(context, projectId);
  const changes = diffStates(current, target);
  if (
    changes.written.length === 0 &&
    changes.removedFiles.length === 0 &&
    changes.removedFolders.length === 0 &&
    target.folders.every((folder) => current.folders.includes(folder))
  ) {
    return changes;
  }

  const hashes = [...new Set(changes.written.map((path) => target.manifest[path] ?? ''))];
  const known = hashes.length
    ? await db.select().from(blobs).where(inArray(blobs.hash, hashes))
    : [];
  const mimeTypes = new Map(known.map((row) => [row.hash, row.mimeType]));
  const incoming: IncomingFile[] = [];
  for (const path of changes.written) {
    const hash = target.manifest[path] ?? '';
    const mimeType = mimeTypes.get(hash);
    if (mimeType === undefined) throw new ApiError('INTERNAL_ERROR', `unknown blob ${hash}`);
    const segments = segmentsOf(path);
    const bytes = await readBlobBytes(s3, config.S3_BUCKET, hash);
    const content = decodeText(segments.at(-1) ?? '', bytes);
    incoming.push(
      content === null
        ? {
            segments,
            kind: 'binary',
            blob: { hash, size: bytes.length, mimeType, bytes },
          }
        : { segments, kind: 'text', content, size: bytes.length },
    );
  }
  // Removed folders include one replaced by a file, cleared before the file is written.
  const cleared = [...changes.removedFiles, ...changes.removedFolders];

  const written = await db.transaction(async (tx) => {
    const closed: string[] = [];
    const ids = new Map(
      [...nodePaths(await listNodes(tx, projectId))].map(([id, path]) => [path, id]),
    );
    for (const path of cleared) {
      const id = ids.get(path);
      if (id === undefined) continue;
      // Deleting a folder takes its content along; later entries below it are skipped.
      ids.delete(path);
      for (const key of [...ids.keys()]) if (key.startsWith(`${path}/`)) ids.delete(key);
      closed.push(...(await deleteNode(tx, projectId, id)));
    }
    const result = await writeFiles(tx, projectId, null, incoming, target.folders.map(segmentsOf));
    await ensureMainFile(tx, projectId);
    await touchProject(tx, projectId);
    return { replaced: result.replaced, closed: [...closed, ...result.closed] };
  });
  await documents.apply(written);
  await publishProjectEvent(redis, projectId, { type: 'tree.changed' });
  return changes;
}
