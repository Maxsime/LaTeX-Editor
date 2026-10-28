import { snapshots, users } from '@galley/db';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { takeSnapshot } from '../history/snapshots.js';
import { withLock } from '../locks.js';
import { materializeProject } from '../materialize.js';
import { readBlobBytes } from '../storage/blobs.js';
import { ensureRepository, MAIN_REF, mainCommit } from './repository.js';
import { git } from './run.js';
import { filesDigest, repositoryRow, saveRepositoryRow } from './state.js';

const SERVER_IDENTITY = { name: 'Galley', email: 'galley@galley.invalid' };

interface TreeNode {
  files: Map<string, string>;
  folders: Map<string, TreeNode>;
}

/** Writes the tree of `node` and its subtrees, bottom up. */
async function writeTree(gitDir: string, node: TreeNode): Promise<string> {
  const lines: string[] = [];
  for (const [name, oid] of node.files) lines.push(`100644 blob ${oid}\t${name}`);
  for (const [name, child] of node.folders) {
    lines.push(`040000 tree ${await writeTree(gitDir, child)}\t${name}`);
  }
  // mktree sorts the entries itself; -z keeps unusual names intact.
  const input = lines.map((line) => `${line}\0`).join('');
  return (await git(gitDir, ['mktree', '-z'], { input })).toString('utf8').trim();
}

/** The project's contributors since the last commit, for its author lines. */
async function authorsSince(
  context: AppContext,
  projectId: string,
  since: Date | undefined,
): Promise<{ name: string; email: string }[]> {
  const { db } = context.database;
  const rows = await db
    .select({ authorIds: snapshots.authorIds })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.projectId, projectId),
        since === undefined ? undefined : gt(snapshots.createdAt, since),
      ),
    );
  const ids = [...new Set(rows.flatMap((row) => row.authorIds))];
  if (ids.length === 0) return [];
  const people = await db
    .select({ displayName: users.displayName, username: users.username })
    .from(users)
    .where(inArray(users.id, ids));
  // E-mail addresses stay private; the username identifies the person instead.
  return people
    .map((person) => ({ name: person.displayName, email: `${person.username}@galley.invalid` }))
    .sort((a, b) => (a.email < b.email ? -1 : 1));
}

/**
 * Makes the repository's `main` hold the project's current files, creating a
 * commit when they changed since the last one served. Called before every
 * reference advertisement, so that a clone or pull always gets the live state.
 *
 * @returns the commit `main` points to.
 */
export async function serveCurrentState(context: AppContext, projectId: string): Promise<string> {
  const gitDir = await ensureRepository(context.config, projectId);
  return withLock(context.redis, gitLockKey(projectId), () =>
    commitCurrentState(context, projectId, gitDir),
  );
}

/** Key of the lock serialising every change to a project's repository. */
export function gitLockKey(projectId: string): string {
  return `git:lock:${projectId}`;
}

/** {@link serveCurrentState} for a caller already holding {@link gitLockKey}. */
export async function commitCurrentState(
  context: AppContext,
  projectId: string,
  gitDir: string,
): Promise<string> {
  const { config, database, s3 } = context;
  const { db } = database;
  const state = await materializeProject(context, projectId);
  const digest = filesDigest(state.manifest);
  const row = await repositoryRow(db, projectId);
  const head = await mainCommit(gitDir);
  // A repository lost from the volume is rebuilt from the project, without its old commits.
  const parent = head !== null && head === row?.commit ? head : null;
  if (parent !== null && row?.digest === digest) return parent;

  // The history records the state first, so that the commit can name its authors.
  await takeSnapshot(context, projectId, 'auto', { state });
  const authors = await authorsSince(
    context,
    projectId,
    parent === null ? undefined : row?.updatedAt,
  );

  const objects = { ...(parent === null ? {} : row?.objects) };
  const root: TreeNode = { files: new Map(), folders: new Map() };
  for (const [path, hash] of Object.entries(state.manifest)) {
    let oid = objects[hash];
    if (oid === undefined) {
      const bytes = await readBlobBytes(s3, config.S3_BUCKET, hash);
      oid = (await git(gitDir, ['hash-object', '-w', '--stdin'], { input: bytes }))
        .toString('utf8')
        .trim();
      objects[hash] = oid;
    }
    const segments = path.split('/');
    const name = segments.pop() ?? path;
    let node = root;
    for (const segment of segments) {
      let child = node.folders.get(segment);
      if (!child) {
        child = { files: new Map(), folders: new Map() };
        node.folders.set(segment, child);
      }
      node = child;
    }
    node.files.set(name, oid);
  }
  const tree = await writeTree(gitDir, root);

  const [author = SERVER_IDENTITY, ...coAuthors] = authors;
  const message = [
    'Update from Galley',
    ...(coAuthors.length
      ? ['', ...coAuthors.map((person) => `Co-authored-by: ${person.name} <${person.email}>`)]
      : []),
    '',
  ].join('\n');
  const commit = (
    await git(gitDir, ['commit-tree', tree, ...(parent === null ? [] : ['-p', parent])], {
      input: message,
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: SERVER_IDENTITY.name,
        GIT_COMMITTER_EMAIL: SERVER_IDENTITY.email,
      },
    })
  )
    .toString('utf8')
    .trim();
  // Moves main only from the commit read above; anything else is a concurrent change.
  await git(gitDir, ['update-ref', MAIN_REF, commit, head ?? '']);
  await saveRepositoryRow(db, projectId, commit, state.manifest, objects);
  return commit;
}
