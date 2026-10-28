import { ApiError, type TreeNode } from '@galley/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type Executor, uniqueViolation, files, projects, yjsStates } from '@galley/db';
import { stateToText, textToState } from '../yjs/text.js';
import { detectMainFile } from './main-file.js';
import type { IncomingFile } from './ingest.js';

type FileRow = typeof files.$inferSelect;

/**
 * Converts a file row for the client. `linkLabel` names the source of a
 * linked file (see `linkLabels`); it defaults to the URL or nothing.
 */
export function toTreeNode(row: FileRow, linkLabel?: string): TreeNode {
  const node: TreeNode = {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    kind: row.kind,
    size: row.kind === 'folder' ? null : (row.size ?? 0),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.link !== null) {
    node.link = {
      source: row.link,
      label: linkLabel ?? (row.link.kind === 'url' ? row.link.url : ''),
      refreshedAt: row.linkRefreshedAt?.toISOString() ?? null,
    };
  }
  return node;
}

export async function listNodes(db: Executor, projectId: string): Promise<FileRow[]> {
  return db.select().from(files).where(eq(files.projectId, projectId));
}

/** Loads one node of a project, or fails with NOT_FOUND. */
export async function getNode(db: Executor, projectId: string, fileId: string): Promise<FileRow> {
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.projectId, projectId), eq(files.id, fileId)))
    .limit(1);
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

/** Fails unless `parentId` is null (project root) or a folder of the project. */
export async function assertFolder(
  db: Executor,
  projectId: string,
  parentId: string | null,
): Promise<void> {
  if (parentId === null) return;
  const node = await getNode(db, projectId, parentId);
  if (node.kind !== 'folder') throw new ApiError('BAD_REQUEST', 'parent is not a folder');
}

function findChild(db: Executor, projectId: string, parentId: string | null, name: string) {
  return db
    .select()
    .from(files)
    .where(
      and(
        eq(files.projectId, projectId),
        parentId === null ? isNull(files.parentId) : eq(files.parentId, parentId),
        eq(files.name, name),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
}

/** Inserts a node, mapping a sibling name clash to CONFLICT. */
async function insertNode(db: Executor, values: typeof files.$inferInsert): Promise<FileRow> {
  try {
    const [row] = await db.insert(files).values(values).returning();
    if (!row) throw new ApiError('INTERNAL_ERROR');
    return row;
  } catch (error) {
    if (uniqueViolation(error)) throw new ApiError('CONFLICT', 'name already used');
    throw error;
  }
}

export function createFolder(
  db: Executor,
  projectId: string,
  parentId: string | null,
  name: string,
): Promise<FileRow> {
  return insertNode(db, { projectId, parentId, name, kind: 'folder' });
}

/**
 * Changes to documents that may be open in an editor. They are applied after
 * the transaction commits, through collab, which holds the live state.
 */
export interface DocumentChanges {
  /** Existing text files whose content is replaced. */
  replaced: { fileId: string; content: string }[];
  /** Text files that were deleted or became binary. */
  closed: string[];
}

/** Result of {@link writeFiles}. */
export interface WrittenFiles extends DocumentChanges {
  rows: FileRow[];
}

/**
 * Writes files below `rootId`, creating intermediate folders and the listed
 * empty folders as needed.
 * An existing file at the same path is replaced; an existing folder is a
 * conflict. Runs inside the caller's transaction. The content of an existing
 * text file is not written here but returned in `replaced`, because only
 * collab may change a document a user can have open.
 */
export async function writeFiles(
  db: Executor,
  projectId: string,
  rootId: string | null,
  incoming: readonly IncomingFile[],
  emptyFolders: readonly (readonly string[])[] = [],
): Promise<WrittenFiles> {
  const folders = new Map<string, string | null>([['', rootId]]);
  const written: FileRow[] = [];
  const replaced: DocumentChanges['replaced'] = [];
  const closed: string[] = [];

  async function folderFor(segments: readonly string[]): Promise<string | null> {
    let key = '';
    let parentId = rootId;
    for (const name of segments) {
      key = key === '' ? name : `${key}/${name}`;
      const cached = folders.get(key);
      if (cached !== undefined) {
        parentId = cached;
        continue;
      }
      const existing = await findChild(db, projectId, parentId, name);
      if (existing && existing.kind !== 'folder') {
        throw new ApiError('CONFLICT', 'a file is in the way of a folder');
      }
      const folder = existing ?? (await createFolder(db, projectId, parentId, name));
      folders.set(key, folder.id);
      parentId = folder.id;
    }
    return parentId;
  }

  for (const segments of emptyFolders) {
    await folderFor(segments);
  }
  for (const file of incoming) {
    const name = file.segments.at(-1);
    if (name === undefined) throw new ApiError('BAD_REQUEST', 'empty path');
    const parentId = await folderFor(file.segments.slice(0, -1));
    const content =
      file.kind === 'text'
        ? { kind: 'text' as const, blobHash: null, size: file.size }
        : { kind: 'binary' as const, blobHash: file.blob.hash, size: file.blob.size };

    const existing = await findChild(db, projectId, parentId, name);
    if (existing?.kind === 'folder') {
      throw new ApiError('CONFLICT', 'a folder already has this name');
    }
    let row: FileRow;
    if (existing) {
      // Replacing a linked file (upload, Git push, restore) makes it an ordinary file.
      const [updated] = await db
        .update(files)
        .set({ ...content, link: null, linkRefreshedAt: null, updatedAt: new Date() })
        .where(eq(files.id, existing.id))
        .returning();
      if (!updated) throw new ApiError('INTERNAL_ERROR');
      row = updated;
      if (file.kind === 'binary' && existing.kind === 'text') {
        await db.delete(yjsStates).where(eq(yjsStates.fileId, row.id));
        closed.push(row.id);
      }
    } else {
      row = await insertNode(db, { projectId, parentId, name, ...content });
    }
    if (file.kind === 'text') {
      if (existing?.kind === 'text') {
        replaced.push({ fileId: row.id, content: file.content });
      } else {
        // A file that was not text has no document anyone could have open.
        await db
          .insert(yjsStates)
          .values({ fileId: row.id, state: textToState(file.content) })
          .onConflictDoNothing();
      }
    }
    written.push(row);
  }
  return { rows: written, replaced, closed };
}

/**
 * Renames and/or moves a node. Moving a folder into itself or one of its
 * descendants is refused.
 */
export async function updateNode(
  db: Executor,
  projectId: string,
  fileId: string,
  change: { name?: string | undefined; parentId?: string | null | undefined },
): Promise<FileRow> {
  const node = await getNode(db, projectId, fileId);
  const parentId = change.parentId === undefined ? node.parentId : change.parentId;
  if (change.parentId !== undefined && change.parentId !== null) {
    await assertFolder(db, projectId, change.parentId);
    if (node.kind === 'folder' && (await isSelfOrDescendant(db, fileId, change.parentId))) {
      throw new ApiError('BAD_REQUEST', 'cannot move a folder into itself');
    }
  }
  try {
    const [row] = await db
      .update(files)
      .set({ name: change.name ?? node.name, parentId, updatedAt: new Date() })
      .where(eq(files.id, fileId))
      .returning();
    if (!row) throw new ApiError('NOT_FOUND');
    return row;
  } catch (error) {
    if (uniqueViolation(error)) throw new ApiError('CONFLICT', 'name already used');
    throw error;
  }
}

/** Tells whether `candidate` is `folderId` or lies below it. */
async function isSelfOrDescendant(
  db: Executor,
  folderId: string,
  candidate: string,
): Promise<boolean> {
  const rows = await db.execute<{ found: boolean }>(sql`
    with recursive ancestors(id, parent_id) as (
      select id, parent_id from ${files} where id = ${candidate}
      union all
      select f.id, f.parent_id from ${files} f join ancestors a on f.id = a.parent_id
    )
    select exists(select 1 from ancestors where id = ${folderId}) as found`);
  return rows[0]?.found === true;
}

/**
 * Deletes a node; children and Yjs states follow through foreign keys.
 *
 * @returns the ids of the deleted text files, whose open documents must be closed.
 */
export async function deleteNode(
  db: Executor,
  projectId: string,
  fileId: string,
): Promise<string[]> {
  const textFiles = await db.execute<{ id: string }>(sql`
    with recursive subtree(id, kind) as (
      select id, kind from ${files} where id = ${fileId} and project_id = ${projectId}
      union all
      select f.id, f.kind from ${files} f join subtree s on f.parent_id = s.id
    )
    select id from subtree where kind = 'text'`);
  const deleted = await db
    .delete(files)
    .where(and(eq(files.projectId, projectId), eq(files.id, fileId)))
    .returning({ id: files.id });
  if (deleted.length === 0) throw new ApiError('NOT_FOUND');
  return textFiles.map((row) => row.id);
}

/** Marks the project as modified, for sorting on the dashboard. */
export async function touchProject(db: Executor, projectId: string): Promise<void> {
  await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
}

/** Project-relative path of every node, keyed by id. */
export function nodePaths(rows: readonly FileRow[]): Map<string, string> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const paths = new Map<string, string>();
  const resolve = (row: FileRow): string => {
    const known = paths.get(row.id);
    if (known !== undefined) return known;
    const parent = row.parentId === null ? undefined : byId.get(row.parentId);
    const path = parent ? `${resolve(parent)}/${row.name}` : row.name;
    paths.set(row.id, path);
    return path;
  };
  rows.forEach(resolve);
  return paths;
}

/**
 * Chooses a main document when the project has none yet, e.g. after an import
 * or the first upload. An explicit choice by the user is never overridden.
 */
export async function ensureMainFile(db: Executor, projectId: string): Promise<string | null> {
  const [project] = await db
    .select({ mainFileId: projects.mainFileId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new ApiError('NOT_FOUND');
  if (project.mainFileId !== null) return project.mainFileId;

  const rows = await db
    .select({ id: files.id, name: files.name, state: yjsStates.state })
    .from(files)
    .innerJoin(yjsStates, eq(yjsStates.fileId, files.id))
    .where(and(eq(files.projectId, projectId), isNull(files.parentId), eq(files.kind, 'text')));
  const mainFileId = detectMainFile(
    rows
      .filter((row) => row.name.toLowerCase().endsWith('.tex'))
      .map((row) => ({ id: row.id, name: row.name, content: stateToText(row.state) })),
  );
  if (mainFileId !== null) {
    await db.update(projects).set({ mainFileId }).where(eq(projects.id, projectId));
  }
  return mainFileId;
}
