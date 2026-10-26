import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cleanOutputs,
  listOutputs,
  openSandboxFile,
  projectDirs,
  type ProjectDirs,
  readSandboxFile,
  syncSources,
} from './workdir.js';

const hash = (char: string) => char.repeat(64);
const contents: Record<string, string> = {
  [hash('a')]: 'version A',
  [hash('b')]: 'version B',
  [hash('c')]: 'chapter',
};

let fetched: string[] = [];
const fetch = (digest: string) => {
  fetched.push(digest);
  return Promise.resolve(Readable.from([Buffer.from(contents[digest] ?? '')]));
};

let dirs: ProjectDirs;
let outside: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'galley-work-'));
  dirs = projectDirs(root, '0193f9f0-4d0a-7c3e-8f5a-1b2c3d4e5f61');
  outside = join(root, 'outside.txt');
  await writeFile(outside, 'host file');
  fetched = [];
});

describe('syncSources', () => {
  it('writes the manifest, then only what changed', async () => {
    expect(
      await syncSources(dirs, { 'main.tex': hash('a'), 'chapters/one.tex': hash('c') }, fetch),
    ).toEqual({ written: 2, removed: 0 });
    expect(await readFile(join(dirs.src, 'chapters/one.tex'), 'utf8')).toBe('chapter');

    fetched = [];
    expect(
      await syncSources(dirs, { 'main.tex': hash('b'), 'chapters/one.tex': hash('c') }, fetch),
    ).toEqual({ written: 1, removed: 0 });
    expect(fetched).toEqual([hash('b')]);
    expect(await readFile(join(dirs.src, 'main.tex'), 'utf8')).toBe('version B');
  });

  it('removes deleted files, files a compilation left, and empty folders', async () => {
    await syncSources(dirs, { 'main.tex': hash('a'), 'chapters/one.tex': hash('c') }, fetch);
    await writeFile(join(dirs.src, 'shell-output.txt'), 'written by a compilation');
    const report = await syncSources(dirs, { 'main.tex': hash('a') }, fetch);
    expect(report).toEqual({ written: 0, removed: 2 });
    expect(await lstat(join(dirs.src, 'chapters')).catch(() => null)).toBeNull();
    expect(await lstat(join(dirs.src, 'shell-output.txt')).catch(() => null)).toBeNull();
  });

  it('never writes through a link the sandbox left behind', async () => {
    await syncSources(dirs, { 'main.tex': hash('a') }, fetch);
    // A compilation replaced a source by a link to a host file, and a folder by a link.
    const { rm } = await import('node:fs/promises');
    await rm(join(dirs.src, 'main.tex'));
    await symlink(outside, join(dirs.src, 'main.tex'));
    await symlink(join(dirs.root), join(dirs.src, 'chapters'));
    await syncSources(dirs, { 'main.tex': hash('a'), 'chapters/one.tex': hash('c') }, fetch);

    expect(await readFile(outside, 'utf8')).toBe('host file');
    expect((await lstat(join(dirs.src, 'main.tex'))).isFile()).toBe(true);
    expect((await lstat(join(dirs.src, 'chapters'))).isDirectory()).toBe(true);
    expect(await lstat(join(dirs.root, 'one.tex')).catch(() => null)).toBeNull();
  });

  it('rewrites everything when the previous manifest is damaged', async () => {
    await syncSources(dirs, { 'main.tex': hash('a') }, fetch);
    await writeFile(dirs.manifestFile, '[not an object]');
    fetched = [];
    await syncSources(dirs, { 'main.tex': hash('a') }, fetch);
    expect(fetched).toEqual([hash('a')]);
  });
});

describe('output files', () => {
  it('reads regular files only and lists outputs without links', async () => {
    await syncSources(dirs, { 'main.tex': hash('a') }, fetch);
    await mkdir(join(dirs.out, 'chapters'), { recursive: true });
    await writeFile(join(dirs.out, 'main.log'), 'log');
    await writeFile(join(dirs.out, 'chapters', 'one.aux'), 'aux');
    await symlink('/proc/self/environ', join(dirs.out, 'main.blg'));

    expect((await readSandboxFile(join(dirs.out, 'main.log'), 100))?.toString()).toBe('log');
    expect(await readSandboxFile(join(dirs.out, 'main.blg'), 100)).toBeNull();
    expect(await readSandboxFile(join(dirs.out, 'main.log'), 2)).toBeNull();
    expect(await readSandboxFile(join(dirs.out, 'chapters'), 100)).toBeNull();
    expect(await readSandboxFile(join(dirs.out, 'missing'), 100)).toBeNull();
    expect(await openSandboxFile(join(dirs.out, 'main.blg'))).toBeNull();
    expect(await openSandboxFile(join(dirs.out, 'chapters'))).toBeNull();
    const opened = await openSandboxFile(join(dirs.out, 'main.log'));
    expect(opened?.size).toBe(3);
    opened?.stream.destroy();
    expect(await readlink(join(dirs.out, 'main.blg'))).toBe('/proc/self/environ');

    expect(await listOutputs(dirs)).toEqual([
      { name: 'chapters/one.aux', size: 3 },
      { name: 'main.log', size: 3 },
    ]);
    await cleanOutputs(dirs);
    expect(await listOutputs(dirs)).toEqual([]);
  });
});
