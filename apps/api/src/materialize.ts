import type { Manifest } from '@galley/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from './context.js';
import { files, yjsStates } from '@galley/db';
import { sha256 } from './files/classify.js';
import { mimeTypeFor } from './files/ingest.js';
import { nodePaths } from './files/tree.js';
import { type BlobSource, storeBlobs } from './storage/blobs.js';
import { stateToText, textBytes } from './yjs/text.js';

/** A consistent snapshot of a project's sources (SPEC §6.2). */
export interface MaterializedProject {
  /** Every file, as `{path: SHA-256 of its content}`; each digest names a stored blob. */
  manifest: Manifest;
  /** Every folder path, so that empty folders survive an export. */
  folders: string[];
}

/**
 * Snapshots a project into content-addressed blobs. Compilation, history,
 * export and Git all read projects through this function only.
 *
 * Text content comes from the stored Yjs states, made current by asking
 * collab to write the documents it holds first.
 */
export async function materializeProject(
  { database, s3, config, documents }: AppContext,
  projectId: string,
): Promise<MaterializedProject> {
  // Open documents are written at most every few seconds; read their current state.
  await documents.flushProject(projectId);
  const { db } = database;
  const rows = await db.select().from(files).where(eq(files.projectId, projectId));
  const states = await db
    .select({ fileId: yjsStates.fileId, state: yjsStates.state })
    .from(yjsStates)
    .innerJoin(files, eq(files.id, yjsStates.fileId))
    .where(eq(files.projectId, projectId));
  const stateById = new Map(states.map((row) => [row.fileId, row.state]));
  const paths = nodePaths(rows);

  const manifest: Manifest = {};
  const folders: string[] = [];
  const textBlobs: BlobSource[] = [];
  for (const row of rows) {
    const path = paths.get(row.id) ?? row.name;
    if (row.kind === 'folder') {
      folders.push(path);
    } else if (row.kind === 'binary' && row.blobHash !== null) {
      manifest[path] = row.blobHash;
    } else if (row.kind === 'text') {
      const state = stateById.get(row.id);
      const bytes = textBytes(state ? stateToText(state) : '');
      const hash = sha256(bytes);
      textBlobs.push({ hash, size: bytes.length, mimeType: mimeTypeFor(row.name), bytes });
      manifest[path] = hash;
    }
  }
  await storeBlobs(db, s3, config.S3_BUCKET, textBlobs);
  return { manifest, folders: folders.sort() };
}
