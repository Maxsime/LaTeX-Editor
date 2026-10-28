import { ApiError, type FileLink, splitProjectPath } from '@galley/shared';
import { type Executor, files, projects, yjsStates } from '@galley/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { storageGuard } from '../admin/quotas.js';
import { instanceSettingsOf } from '../admin/settings.js';
import type { AppContext } from '../context.js';
import { decodeText, sha256 } from '../files/classify.js';
import { type IncomingFile, mimeTypeFor } from '../files/ingest.js';
import {
  assertFolder,
  ensureMainFile,
  getNode,
  listNodes,
  nodePaths,
  writeFiles,
} from '../files/tree.js';
import { loadProject } from '../projects/access.js';
import { readBlobBytes, storeBlobs } from '../storage/blobs.js';
import { stateToText, textBytes } from '../yjs/text.js';
import { createLinkFetcher, type LinkFetcher } from './fetch.js';

type FileRow = typeof files.$inferSelect;

let defaultFetcher: LinkFetcher | undefined;

function fetcherOf(context: AppContext): LinkFetcher {
  if (context.linkFetcher) return context.linkFetcher;
  defaultFetcher ??= createLinkFetcher();
  return defaultFetcher;
}

/**
 * Reads the current content of a link's source on behalf of `userId`. A
 * project source is read with that person's rights, checked at every refresh:
 * losing access to the source stops the refreshes.
 */
async function readSource(
  context: AppContext,
  userId: string,
  link: FileLink,
): Promise<Uint8Array> {
  if (link.kind === 'url') {
    if (!context.config.LINKED_URLS_ENABLED) throw new ApiError('LINKS_DISABLED');
    return (await fetcherOf(context)(link.url)).bytes;
  }
  const { db } = context.database;
  await loadProject(db, link.projectId, userId, 'reader');
  const node = await getNode(db, link.projectId, link.fileId);
  if (node.kind === 'binary' && node.blobHash !== null) {
    return readBlobBytes(context.s3, context.config.S3_BUCKET, node.blobHash);
  }
  if (node.kind !== 'text') throw new ApiError('BAD_REQUEST', 'a folder cannot be linked');
  await context.documents.flushProject(link.projectId);
  const [row] = await db
    .select({ state: yjsStates.state })
    .from(yjsStates)
    .where(eq(yjsStates.fileId, node.id));
  return textBytes(row ? stateToText(row.state) : '');
}

function incomingFile(segments: string[], bytes: Uint8Array): IncomingFile {
  const name = segments.at(-1) ?? '';
  const content = decodeText(name, bytes);
  if (content !== null) return { segments, kind: 'text', content, size: bytes.length };
  return {
    segments,
    kind: 'binary',
    blob: { hash: sha256(bytes), size: bytes.length, mimeType: mimeTypeFor(name), bytes },
  };
}

/**
 * Writes `bytes` at `segments` (below the project root) and records the link,
 * in one transaction under the owner's storage quota; open editors receive a
 * new text through collab.
 */
async function writeLinked(
  context: AppContext,
  projectId: string,
  segments: string[],
  bytes: Uint8Array,
  link: FileLink,
): Promise<FileRow> {
  const { db } = context.database;
  const file = incomingFile(segments, bytes);
  if (file.kind === 'binary') {
    await storeBlobs(db, context.s3, context.config.S3_BUCKET, [file.blob]);
  }
  const { quotas } = await instanceSettingsOf(context).get();
  const { row, changes } = await db.transaction(async (tx) => {
    const guard = await storageGuard(tx, quotas, projectId);
    const written = await writeFiles(tx, projectId, null, [file]);
    await guard.check();
    const [first] = written.rows;
    if (!first) throw new ApiError('INTERNAL_ERROR');
    const [linked] = await tx
      .update(files)
      .set({ link, linkRefreshedAt: new Date() })
      .where(eq(files.id, first.id))
      .returning();
    await ensureMainFile(tx, projectId);
    return { row: linked ?? first, changes: written };
  });
  await context.documents.apply(changes);
  return row;
}

async function pathOf(db: Executor, projectId: string, fileId: string | null): Promise<string[]> {
  if (fileId === null) return [];
  const path = nodePaths(await listNodes(db, projectId)).get(fileId);
  const segments = path === undefined ? null : splitProjectPath(path);
  if (segments === null) throw new ApiError('NOT_FOUND');
  return segments;
}

/** Creates a linked file named `name` in folder `parentId`; a taken name is a conflict. */
export async function createLinkedFile(
  context: AppContext,
  userId: string,
  projectId: string,
  input: { parentId: string | null; name: string; link: FileLink },
): Promise<FileRow> {
  const { db } = context.database;
  if (input.link.kind === 'project' && input.link.projectId === projectId) {
    throw new ApiError('BAD_REQUEST', 'a file cannot be linked to its own project');
  }
  await assertFolder(db, projectId, input.parentId);
  const segments = [...(await pathOf(db, projectId, input.parentId)), input.name];
  const [existing] = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.projectId, projectId),
        eq(files.name, input.name),
        input.parentId === null ? isNull(files.parentId) : eq(files.parentId, input.parentId),
      ),
    );
  if (existing) throw new ApiError('CONFLICT', 'a file already has this name');
  const bytes = await readSource(context, userId, input.link);
  return writeLinked(context, projectId, segments, bytes, input.link);
}

/** Reads a linked file's source again and replaces its content. */
export async function refreshLinkedFile(
  context: AppContext,
  userId: string,
  projectId: string,
  fileId: string,
): Promise<FileRow> {
  const { db } = context.database;
  const node = await getNode(db, projectId, fileId);
  if (node.link === null) throw new ApiError('BAD_REQUEST', 'not a linked file');
  const bytes = await readSource(context, userId, node.link);
  const segments = await pathOf(db, projectId, fileId);
  return writeLinked(context, projectId, segments, bytes, node.link);
}

/** Keeps a linked file's current content as an ordinary, editable file. */
export async function unlinkFile(
  context: AppContext,
  projectId: string,
  fileId: string,
): Promise<FileRow> {
  const { db } = context.database;
  const node = await getNode(db, projectId, fileId);
  const [row] = await db
    .update(files)
    .set({ link: null, linkRefreshedAt: null, updatedAt: new Date() })
    .where(eq(files.id, node.id))
    .returning();
  return row ?? node;
}

/**
 * Names the sources of the linked files among `rows`: the URL, or the source
 * project's name and file name when the reader can see that project.
 */
export async function linkLabels(
  db: Executor,
  userId: string,
  rows: readonly FileRow[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const sources = rows.flatMap((row) =>
    row.link?.kind === 'project' ? [{ id: row.id, link: row.link }] : [],
  );
  for (const row of rows) if (row.link?.kind === 'url') labels.set(row.id, row.link.url);
  if (sources.length === 0) return labels;
  const fileIds = [...new Set(sources.map((source) => source.link.fileId))];
  const named = await db
    .select({
      fileId: files.id,
      fileName: files.name,
      projectName: projects.name,
      projectId: projects.id,
    })
    .from(files)
    .innerJoin(projects, eq(projects.id, files.projectId))
    .where(inArray(files.id, fileIds));
  const visible = new Set<string>();
  for (const projectId of new Set(named.map((row) => row.projectId))) {
    try {
      await loadProject(db, projectId, userId, 'reader');
      visible.add(projectId);
    } catch {
      // A project the reader cannot see is not named.
    }
  }
  const byFile = new Map(named.map((row) => [row.fileId, row]));
  for (const source of sources) {
    const row = byFile.get(source.link.fileId);
    labels.set(
      source.id,
      row !== undefined && visible.has(row.projectId) ? `${row.projectName} › ${row.fileName}` : '',
    );
  }
  return labels;
}
