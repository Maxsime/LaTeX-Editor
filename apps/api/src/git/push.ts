import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { MAX_UPLOAD_BYTES, type Manifest, splitProjectPath } from '@galley/shared';
import type { AppContext } from '../context.js';
import { sha256 } from '../files/classify.js';
import { mimeTypeFor } from '../files/ingest.js';
import { applyState } from '../history/apply.js';
import { recordActivity, takeSnapshot } from '../history/snapshots.js';
import { withLock } from '../locks.js';
import { materializeProject } from '../materialize.js';
import { type BlobSource, storeBlobs } from '../storage/blobs.js';
import { MAIN_REF } from './repository.js';
import { git } from './run.js';
import { filesDigest, repositoryRow, saveRepositoryRow } from './state.js';

const ZERO_ID = /^0+$/;

/** Why a push is refused; each reason has a message for the user. */
export type PushRefusal =
  | { reason: 'onlyMain' }
  | { reason: 'fetchFirst' }
  | { reason: 'symlink'; path: string }
  | { reason: 'submodule'; path: string }
  | { reason: 'invalidPath'; path: string }
  | { reason: 'fileTooLarge'; path: string }
  | { reason: 'tooLarge' }
  | { reason: 'tooManyFiles' };

export class PushRefused extends Error {
  constructor(readonly refusal: PushRefusal) {
    super(`push refused: ${refusal.reason}`);
  }
}

export interface RefUpdate {
  oldId: string;
  newId: string;
  ref: string;
}

export interface PushRequest {
  projectId: string;
  userId: string;
  gitDir: string;
  updates: readonly RefUpdate[];
  /** Quarantine directory where `receive-pack` keeps the pushed objects until accepted. */
  objectDirectory: string | null;
}

export interface PushLimits {
  maxBytes: number;
  maxEntries: number;
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  size: number;
  path: string;
}

/** Parses `git ls-tree -r -l -z` output. */
function parseTree(output: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.toString('utf8').split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode = '', type = '', oid = '', size = ''] = record.slice(0, tab).split(/ +/);
    entries.push({ mode, type, oid, size: Number(size), path: record.slice(tab + 1) });
  }
  return entries;
}

/** Makes sure the quarantine directory Git named is inside the repository. */
async function objectEnvironment(
  gitDir: string,
  objectDirectory: string | null,
): Promise<Record<string, string>> {
  if (objectDirectory === null) return {};
  const objects = await realpath(join(gitDir, 'objects'));
  const quarantine = await realpath(objectDirectory);
  if (!quarantine.startsWith(`${objects}${sep}`)) {
    throw new Error('object directory outside the repository');
  }
  return { GIT_OBJECT_DIRECTORY: quarantine, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
}

/**
 * Applies a push to the project, from the repository's pre-receive hook. The
 * pushed tree replaces the project's files in one transaction, then becomes a
 * snapshot of kind `git`. The push must start from the commit last served and
 * the project must not have changed since; otherwise the user pulls first, and
 * Git merges on their side.
 *
 * @throws {PushRefused} when the push cannot be accepted as it is.
 */
export async function applyPush(
  context: AppContext,
  push: PushRequest,
  limits: PushLimits,
): Promise<void> {
  const { database, redis, s3, config } = context;
  const { db } = database;
  const { projectId, gitDir } = push;
  const [update, ...others] = push.updates;
  if (!update || others.length > 0 || update.ref !== MAIN_REF || ZERO_ID.test(update.newId)) {
    throw new PushRefused({ reason: 'onlyMain' });
  }
  const env = await objectEnvironment(gitDir, push.objectDirectory);

  await withLock(redis, `git:lock:${projectId}`, async () => {
    const row = await repositoryRow(db, projectId);
    const current = await materializeProject(context, projectId);
    if (row?.commit !== update.oldId || row.digest !== filesDigest(current.manifest)) {
      throw new PushRefused({ reason: 'fetchFirst' });
    }

    const entries = parseTree(
      await git(gitDir, ['ls-tree', '-r', '-l', '-z', '--full-tree', update.newId], { env }),
    );
    if (entries.length > limits.maxEntries) throw new PushRefused({ reason: 'tooManyFiles' });
    let total = 0;
    for (const entry of entries) {
      if (entry.mode === '120000') throw new PushRefused({ reason: 'symlink', path: entry.path });
      if (entry.type === 'commit') {
        throw new PushRefused({ reason: 'submodule', path: entry.path });
      }
      if (
        entry.type !== 'blob' ||
        (entry.mode !== '100644' && entry.mode !== '100755') ||
        entry.path.includes('�') ||
        splitProjectPath(entry.path) === null
      ) {
        throw new PushRefused({ reason: 'invalidPath', path: entry.path });
      }
      if (entry.size > MAX_UPLOAD_BYTES) {
        throw new PushRefused({ reason: 'fileTooLarge', path: entry.path });
      }
      total += entry.size;
      if (total > limits.maxBytes) throw new PushRefused({ reason: 'tooLarge' });
    }

    // Blobs the project already has are known by their Git id; only new ones are read.
    const known = new Map(Object.entries(row.objects).map(([hash, oid]) => [oid, hash]));
    const objects = { ...row.objects };
    const manifest: Manifest = {};
    const incoming: BlobSource[] = [];
    for (const entry of entries) {
      let hash = known.get(entry.oid);
      if (hash === undefined) {
        const bytes = await git(gitDir, ['cat-file', 'blob', entry.oid], { env });
        hash = sha256(bytes);
        const name = entry.path.split('/').at(-1) ?? entry.path;
        incoming.push({ hash, size: bytes.length, mimeType: mimeTypeFor(name), bytes });
        known.set(entry.oid, hash);
        objects[hash] = entry.oid;
      }
      manifest[entry.path] = hash;
    }
    await storeBlobs(db, s3, config.S3_BUCKET, incoming);

    // Git cannot hold empty folders: those of the project stay as they are.
    const filePaths = Object.keys(manifest);
    const folders = current.folders.filter(
      (folder) =>
        !Object.keys(current.manifest).some((path) => path.startsWith(`${folder}/`)) &&
        !filePaths.some((path) => path === folder || path.startsWith(`${folder}/`)),
    );
    await applyState(context, projectId, { manifest, folders });
    await recordActivity(db, projectId, push.userId);
    await takeSnapshot(context, projectId, 'git', { authorIds: [push.userId] });
    await saveRepositoryRow(db, projectId, update.newId, manifest, objects);
  });
}
