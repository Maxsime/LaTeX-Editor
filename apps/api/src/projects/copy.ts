import { ApiError, type CopyFilesRequest, type Manifest } from '@galley/shared';
import { type Executor, projects } from '@galley/db';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { listNodes, nodePaths } from '../files/tree.js';
import { applyState } from '../history/apply.js';
import type { ProjectState } from '../history/state.js';
import { materializeProject } from '../materialize.js';
import type { ProjectRow } from './access.js';
import { insertProject } from './service.js';

/** Compile and writing settings a copy or a template carries over. */
export type ProjectSettings = Partial<
  Pick<
    typeof projects.$inferInsert,
    | 'engine'
    | 'bibTool'
    | 'shellEscape'
    | 'aiEnabled'
    | 'citeKeyPattern'
    | 'spellLanguage'
    | 'chktexDisabled'
    | 'precompilePreamble'
  >
>;

/** The settings of `project` that a duplicate keeps. */
export function settingsOf(project: ProjectRow): ProjectSettings {
  return {
    engine: project.engine,
    bibTool: project.bibTool,
    shellEscape: project.shellEscape,
    aiEnabled: project.aiEnabled,
    citeKeyPattern: project.citeKeyPattern,
    spellLanguage: project.spellLanguage,
    chktexDisabled: project.chktexDisabled,
    precompilePreamble: project.precompilePreamble,
  };
}

async function fileIdAt(db: Executor, projectId: string, path: string): Promise<string | null> {
  for (const [id, nodePath] of nodePaths(await listNodes(db, projectId))) {
    if (nodePath === path) return id;
  }
  return null;
}

/**
 * Creates a project owned by `ownerId` holding `state`, with `mainPath` as its
 * main file when present. Contents are written like a history restore, so the
 * owner's storage quota applies; the project is removed again if that fails.
 */
export async function createProjectFromState(
  context: AppContext,
  ownerId: string,
  input: { name: string; state: ProjectState; mainPath: string | null; settings: ProjectSettings },
): Promise<ProjectRow> {
  const { db } = context.database;
  const created = await insertProject(db, ownerId, input.name);
  try {
    if (Object.keys(input.settings).length > 0) {
      await db.update(projects).set(input.settings).where(eq(projects.id, created.id));
    }
    await applyState(context, created.id, input.state);
    const mainFileId =
      input.mainPath === null ? null : await fileIdAt(db, created.id, input.mainPath);
    const [row] = await db
      .update(projects)
      .set(mainFileId === null ? {} : { mainFileId })
      .where(eq(projects.id, created.id))
      .returning();
    return row ?? created;
  } catch (error) {
    await db.delete(projects).where(eq(projects.id, created.id));
    throw error;
  }
}

/**
 * Copies a project's current files into a new project of `ownerId`: the text
 * as it stands (suggested changes included, comments left behind), binaries
 * by reference to the same stored objects, and the settings. History and
 * members are not copied.
 */
export async function duplicateProject(
  context: AppContext,
  source: ProjectRow,
  ownerId: string,
  name: string,
): Promise<ProjectRow> {
  const snapshot = await materializeProject(context, source.id);
  const mainPath =
    source.mainFileId === null ? null : (snapshot.paths.get(source.mainFileId) ?? null);
  return createProjectFromState(context, ownerId, {
    name,
    state: { manifest: snapshot.manifest, folders: snapshot.folders },
    mainPath,
    settings: settingsOf(source),
  });
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function join(folder: string, path: string): string {
  return folder === '' ? path : `${folder}/${path}`;
}

/**
 * Computes the state of `target` once the listed files and folders of
 * `source` are copied into `folder` (a folder path of `target`, `''` for the
 * root), keeping the structure below each copied folder. Copies never replace
 * anything: a name already taken is a conflict. Pure, for testing.
 */
export function stateWithCopies(
  source: { manifest: Manifest; folders: readonly string[]; paths: ReadonlyMap<string, string> },
  target: ProjectState,
  fileIds: readonly string[],
  folder: string,
): ProjectState {
  const manifest: Manifest = { ...target.manifest };
  const folders = new Set(target.folders);
  const taken = (path: string) => path in manifest || folders.has(path);

  for (const id of fileIds) {
    const path = source.paths.get(id);
    if (path === undefined) throw new ApiError('NOT_FOUND');
    const base = parentOf(path);
    const relocate = (inner: string) =>
      join(folder, base === '' ? inner : inner.slice(base.length + 1));
    const hash = source.manifest[path];
    if (hash !== undefined) {
      const destination = relocate(path);
      if (taken(destination)) throw new ApiError('CONFLICT', 'a file already has this name');
      manifest[destination] = hash;
      continue;
    }
    if (!source.folders.includes(path)) throw new ApiError('NOT_FOUND');
    const root = relocate(path);
    if (taken(root)) throw new ApiError('CONFLICT', 'a file already has this name');
    folders.add(root);
    for (const inner of source.folders) {
      if (inner.startsWith(`${path}/`)) folders.add(relocate(inner));
    }
    for (const [inner, innerHash] of Object.entries(source.manifest)) {
      if (inner.startsWith(`${path}/`)) manifest[relocate(inner)] = innerHash;
    }
  }
  return { manifest, folders: [...folders].sort() };
}

/** Copies files or folders of `source` into a folder of `target` (see {@link stateWithCopies}). */
export async function copyFiles(
  context: AppContext,
  sourceId: string,
  targetId: string,
  request: Pick<CopyFilesRequest, 'fileIds' | 'targetFolderId'>,
): Promise<void> {
  const source = await materializeProject(context, sourceId);
  const target = await materializeProject(context, targetId);
  let folder = '';
  if (request.targetFolderId !== null) {
    const path = target.paths.get(request.targetFolderId);
    if (path === undefined || !target.folders.includes(path)) {
      throw new ApiError('BAD_REQUEST', 'the target is not a folder');
    }
    folder = path;
  }
  const state = stateWithCopies(source, target, request.fileIds, folder);
  await applyState(context, targetId, state);
}
