import { execFileSync } from 'node:child_process';
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
  writeSandboxFile,
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

describe('links and special files left by a compilation', () => {
  it('refuses a file reached through a linked folder', async () => {
    await syncSources(dirs, { 'main.tex': hash('a') }, fetch);
    // A compilation can replace a folder of its sources by a link: the worker must not
    // then read the host's files, its own environment included, through that path.
    await symlink(join(dirs.root, '..'), join(dirs.src, 'up'));
    await symlink('/proc/self', join(dirs.src, 'proc'));
    expect(await readFile(join(dirs.src, 'up', 'outside.txt'), 'utf8')).toBe('host file');

    expect(await readSandboxFile(join(dirs.src, 'up', 'outside.txt'), 100)).toBeNull();
    expect(await readSandboxFile(join(dirs.src, 'proc', 'environ'), 1_000_000)).toBeNull();
    expect(await openSandboxFile(join(dirs.src, 'up', 'outside.txt'))).toBeNull();
    expect((await readSandboxFile(join(dirs.src, 'main.tex'), 100))?.toString()).toBe('version A');
  });

  it('refuses a named pipe without waiting for a writer', async () => {
    await syncSources(dirs, { 'main.tex': hash('a') }, fetch);
    execFileSync('mkfifo', [join(dirs.out, 'main.log')]);
    expect(await readSandboxFile(join(dirs.out, 'main.log'), 100)).toBeNull();
    expect(await openSandboxFile(join(dirs.out, 'main.log'))).toBeNull();
  }, 5_000);

  it('writes in place of a link instead of through it', async () => {
    await syncSources(dirs, { 'main.tex': hash('a') }, fetch);
    const stamp = join(dirs.out, 'galley-preamble.stamp');
    await symlink(outside, stamp);
    await writeSandboxFile(stamp, 'fingerprint');

    expect(await readFile(outside, 'utf8')).toBe('host file');
    expect((await lstat(stamp)).isFile()).toBe(true);
    expect(await readFile(stamp, 'utf8')).toBe('fingerprint');
  });
});
