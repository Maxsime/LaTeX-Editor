import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { directorySize } from './sandbox.js';

const SIZE_FILE = 'size.json';
const PROJECT_ID = /^[0-9a-f-]{36}$/;

/** Records the disk usage of a project's working directory, read back by {@link enforceQuota}. */
export async function recordSize(projectRoot: string): Promise<number> {
  const size = await directorySize(projectRoot);
  await writeFile(join(projectRoot, SIZE_FILE), JSON.stringify({ size }));
  return size;
}

interface WorkDir {
  projectId: string;
  path: string;
  size: number;
  usedAt: number;
}

async function readWorkDirs(workRoot: string): Promise<WorkDir[]> {
  const names = await readdir(workRoot).catch(() => []);
  const dirs: WorkDir[] = [];
  for (const name of names) {
    if (!PROJECT_ID.test(name)) continue;
    const path = join(workRoot, name);
    try {
      const [info, recorded] = await Promise.all([
        stat(path),
        readFile(join(path, SIZE_FILE), 'utf8'),
      ]);
      const parsed: unknown = JSON.parse(recorded);
      const size =
        parsed !== null &&
        typeof parsed === 'object' &&
        'size' in parsed &&
        typeof parsed.size === 'number'
          ? parsed.size
          : 0;
      dirs.push({ projectId: name, path, size, usedAt: info.mtimeMs });
    } catch {
      // A directory without a recorded size is being created; leave it.
    }
  }
  return dirs;
}

/**
 * Deletes the least recently compiled working directories until the total fits
 * the quota. Directories of compilations in progress are kept.
 *
 * @returns The ids of the evicted projects.
 */
export async function enforceQuota(
  workRoot: string,
  quotaBytes: number,
  isBusy: (projectId: string) => Promise<boolean>,
): Promise<string[]> {
  const dirs = await readWorkDirs(workRoot);
  let total = dirs.reduce((sum, dir) => sum + dir.size, 0);
  const evicted: string[] = [];
  for (const dir of dirs.sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= quotaBytes) break;
    if (await isBusy(dir.projectId)) continue;
    await rm(dir.path, { recursive: true, force: true });
    total -= dir.size;
    evicted.push(dir.projectId);
  }
  return evicted;
}
