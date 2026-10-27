import { type Manifest } from '@galley/shared';
import { gitRepositories, type Executor } from '@galley/db';
import { eq } from 'drizzle-orm';
import { stateDigest } from '../history/state.js';

export type RepositoryRow = typeof gitRepositories.$inferSelect;

/**
 * Digest of what a commit can hold: files only, since Git has no empty
 * folders. A project whose files match its last commit needs no new one.
 */
export function filesDigest(manifest: Manifest): string {
  return stateDigest({ manifest, folders: [] });
}

export async function repositoryRow(
  db: Executor,
  projectId: string,
): Promise<RepositoryRow | undefined> {
  const [row] = await db
    .select()
    .from(gitRepositories)
    .where(eq(gitRepositories.projectId, projectId));
  return row;
}

/** Records the commit now served, keeping only the object ids it uses. */
export async function saveRepositoryRow(
  db: Executor,
  projectId: string,
  commit: string,
  manifest: Manifest,
  objects: Record<string, string>,
): Promise<void> {
  const used: Record<string, string> = {};
  for (const hash of Object.values(manifest)) {
    const oid = objects[hash];
    if (oid !== undefined) used[hash] = oid;
  }
  const values = { commit, digest: filesDigest(manifest), objects: used, updatedAt: new Date() };
  await db
    .insert(gitRepositories)
    .values({ projectId, ...values })
    .onConflictDoUpdate({ target: gitRepositories.projectId, set: values });
}
