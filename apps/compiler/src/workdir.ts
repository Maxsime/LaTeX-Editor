import { constants, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Manifest } from '@galley/shared';

/** Directories of one project inside the worker's work root. */
export interface ProjectDirs {
  root: string;
  /** Sources, mirrored from the manifest; mounted in the sandbox. */
  src: string;
  /** Auxiliary and output files kept between compilations; mounted in the sandbox. */
  out: string;
  /** Manifest of the last synchronisation, out of the sandbox's reach. */
  manifestFile: string;
  /** The project owner's personal texmf tree, mounted read-only as `TEXMFHOME`. */
  texmf: string;
  texmfManifestFile: string;
}

/** Lays out the working directory of a project. */
export function projectDirs(workRoot: string, projectId: string): ProjectDirs {
  const root = join(workRoot, projectId);
  return {
    root,
    src: join(root, 'src'),
    out: join(root, 'out'),
    manifestFile: join(root, 'manifest.json'),
    texmf: join(root, 'texmf'),
    texmfManifestFile: join(root, 'texmf-manifest.json'),
  };
}

/** Opens a blob of the object store by its digest. */
export type BlobFetcher = (hash: string) => Promise<Readable>;

async function readPreviousManifest(file: string): Promise<Manifest> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Written by this module only; entries are checked again before use.
      return parsed as Manifest;
    }
  } catch {
    // Missing or damaged: everything is rewritten.
  }
  return {};
}

/**
 * Creates the directories leading to `relative` below `base`, replacing any
 * link or file found in their place. The sandbox can leave links in its
 * writable folders, and the worker, which writes here unconfined, must never
 * follow one.
 */
async function ensureDirectory(base: string, relative: string): Promise<void> {
  let current = base;
  for (const segment of relative.split('/').filter((part) => part !== '')) {
    current = join(current, segment);
    const stat = await lstat(current).catch(() => null);
    if (stat?.isDirectory()) continue;
    if (stat) await rm(current, { force: true });
    await mkdir(current);
  }
}

/** Writes a stream to `path` through a temporary file renamed in place, which replaces a link instead of following it. */
async function writeAtomically(path: string, content: Readable): Promise<void> {
  const temporary = join(
    dirname(path),
    `.galley-${process.pid.toString(36)}-${Date.now().toString(36)}`,
  );
  await pipeline(content, createWriteStream(temporary, { flags: 'wx' }));
  const existing = await lstat(path).catch(() => null);
  if (existing?.isDirectory()) await rm(path, { recursive: true, force: true });
  await rename(temporary, path);
}

/** Lists the entries below a directory, without following links. */
async function walk(dir: string, prefix = ''): Promise<{ path: string; directory: boolean }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: { path: string; directory: boolean }[] = [];
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await walk(join(dir, entry.name), path)), { path, directory: true });
    } else {
      found.push({ path, directory: false });
    }
  }
  return found;
}

/** Outcome of {@link syncSources}. */
export interface SyncReport {
  written: number;
  removed: number;
}

/**
 * Makes the source folder match the manifest. Files whose digest did not change
 * since the previous compilation are left alone, which keeps latexmk's view of
 * them; anything else in the folder (a deleted file, something a compilation
 * wrote there, a link) is removed.
 */
export async function syncSources(
  dirs: ProjectDirs,
  manifest: Manifest,
  fetch: BlobFetcher,
): Promise<SyncReport> {
  await mkdir(dirs.out, { recursive: true });
  const report = await syncTree(dirs.src, dirs.manifestFile, manifest, fetch);
  // The root's modification time orders projects for eviction.
  const now = new Date();
  await utimes(dirs.root, now, now);
  return report;
}

/**
 * Makes the project's copy of its owner's texmf tree match `manifest`, the
 * same way as the sources. Each project keeps its own copy, evicted with it.
 */
export async function syncTexmf(
  dirs: ProjectDirs,
  manifest: Manifest,
  fetch: BlobFetcher,
): Promise<SyncReport> {
  return syncTree(dirs.texmf, dirs.texmfManifestFile, manifest, fetch);
}

async function syncTree(
  dir: string,
  manifestFile: string,
  manifest: Manifest,
  fetch: BlobFetcher,
): Promise<SyncReport> {
  await mkdir(dir, { recursive: true });
  const previous = await readPreviousManifest(manifestFile);
  // Forget the old manifest first: an interrupted sync must not be trusted next time.
  await rm(manifestFile, { force: true });

  const report: SyncReport = { written: 0, removed: 0 };
  const directories = new Set<string>();
  for (const path of Object.keys(manifest)) {
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
      directories.add(path.slice(0, slash));
    }
  }

  // Remove what the manifest does not list, deepest entries first.
  for (const entry of await walk(dir)) {
    const keep = entry.directory ? directories.has(entry.path) : entry.path in manifest;
    const stat = await lstat(join(dir, entry.path)).catch(() => null);
    const sameKind = entry.directory ? stat?.isDirectory() : stat?.isFile();
    if (!keep || !sameKind) {
      await rm(join(dir, entry.path), { recursive: true, force: true });
      if (!entry.directory) report.removed += 1;
    }
  }

  for (const [path, hash] of Object.entries(manifest)) {
    const target = join(dir, path);
    if (previous[path] === hash && (await lstat(target).catch(() => null))?.isFile()) continue;
    await ensureDirectory(dir, dirname(path) === '.' ? '' : dirname(path));
    await writeAtomically(target, await fetch(hash));
    report.written += 1;
  }

  await writeFile(manifestFile, JSON.stringify(manifest));
  return report;
}

/** Empties the output folder ("clean and recompile"). */
export async function cleanOutputs(dirs: ProjectDirs): Promise<void> {
  await rm(dirs.out, { recursive: true, force: true });
  await mkdir(dirs.out, { recursive: true });
}

/**
 * Reads a file written by the sandbox, refusing links and anything but a
 * regular file. Returns null when it is missing or refused.
 */
export async function readSandboxFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Opens a file written by the sandbox as a stream, refusing links and anything
 * but a regular file. Returns null when it is missing or refused.
 */
export async function openSandboxFile(
  path: string,
): Promise<{ stream: Readable; size: number } | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    return null;
  }
  return { stream: handle.createReadStream(), size: stat.size };
}

/** A regular file of the output folder. */
export interface OutputFile {
  /** Path relative to the output folder. */
  name: string;
  size: number;
}

/** Lists the regular files of the output folder, skipping links. */
export async function listOutputs(dirs: ProjectDirs): Promise<OutputFile[]> {
  const files: OutputFile[] = [];
  for (const entry of await walk(dirs.out)) {
    if (entry.directory) continue;
    const stat = await lstat(join(dirs.out, entry.path)).catch(() => null);
    if (stat?.isFile()) files.push({ name: entry.path, size: stat.size });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
