import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { type Executor, files, projects, snapshots, users, yjsStates } from '@galley/db';
import { asc } from 'drizzle-orm';
import { stateToText } from '../yjs/text.js';
import { listObjects } from './objects.js';

/** What a restore must bring back, summed up so that two instances can be compared. */
export interface Fingerprint {
  users: number;
  projects: number;
  files: number;
  snapshots: number;
  objects: number;
  /** SHA-256 over accounts, projects, the tree, every file's content and every version. */
  digest: string;
}

/**
 * Fingerprints the durable content of an instance: accounts, projects, files
 * with their text, history versions and stored objects. Sessions, queues and
 * caches are left out: a restore does not need to bring them back.
 */
export async function fingerprint(
  db: Executor,
  s3: S3Client,
  bucket: string,
): Promise<Fingerprint> {
  const hash = createHash('sha256');
  const add = (...parts: (string | number | null)[]) => {
    hash.update(`${parts.map((part) => String(part)).join('\0')}\n`);
  };

  const accounts = await db.select().from(users).orderBy(asc(users.id));
  for (const row of accounts) {
    add('user', row.id, row.email, row.username, row.passwordHash, String(row.isAdmin));
  }
  const projectRows = await db.select().from(projects).orderBy(asc(projects.id));
  for (const row of projectRows) add('project', row.id, row.ownerId, row.name, row.mainFileId);
  const fileRows = await db.select().from(files).orderBy(asc(files.id));
  for (const row of fileRows) {
    add('file', row.id, row.projectId, row.parentId, row.name, row.kind, row.blobHash, row.size);
  }
  // Text is compared, not the encoded state, which may be compacted on load.
  const states = await db.select().from(yjsStates).orderBy(asc(yjsStates.fileId));
  for (const row of states) {
    add('text', row.fileId, createHash('sha256').update(stateToText(row.state)).digest('hex'));
  }
  const versions = await db.select().from(snapshots).orderBy(asc(snapshots.id));
  for (const row of versions) add('snapshot', row.id, row.projectId, row.kind, row.label);
  let objects = 0;
  for await (const object of listObjects(s3, bucket)) {
    add('object', object.key, object.size);
    objects += 1;
  }
  return {
    users: accounts.length,
    projects: projectRows.length,
    files: fileRows.length,
    snapshots: versions.length,
    objects,
    digest: hash.digest('hex'),
  };
}
