import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bwrapArgs, directorySize } from './sandbox.js';

const paths = {
  texliveDir: '/usr/local/texlive/2026',
  assetsDir: '/opt/galley',
  srcDir: '/work/p/src',
  outDir: '/work/p/out',
  texmfDir: '/opt/galley/texmf',
};
const limits = {
  timeoutMs: 180_000,
  memoryBytes: 2 * 1024 ** 3,
  maxProcesses: 64,
  maxOutputBytes: 500 * 1024 ** 2,
};

/** Pairs of `--flag value` following a given flag, e.g. every `--setenv NAME VALUE`. */
function triples(args: string[], flag: string): [string, string][] {
  const found: [string, string][] = [];
  args.forEach((arg, index) => {
    if (arg === flag) found.push([args[index + 1] ?? '', args[index + 2] ?? '']);
  });
  return found;
}

describe('bwrapArgs', () => {
  const args = bwrapArgs(paths, limits, 'thesis', ['latexmk', 'main.tex']);

  it('isolates every namespace and dies with the worker', () => {
    expect(args.slice(0, 4)).toEqual([
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--clearenv',
    ]);
    expect(args).not.toContain('--share-net');
  });

  it('exposes the project, its outputs and read-only system parts only', () => {
    const binds = triples(args, '--bind');
    expect(binds).toEqual([
      ['/work/p/src', '/project'],
      ['/work/p/out', '/out'],
    ]);
    const readOnly = triples(args, '--ro-bind').map(([, target]) => target);
    expect(readOnly).toEqual(
      expect.arrayContaining([
        '/usr',
        '/usr/local/texlive/2026',
        '/etc/passwd',
        '/galley/latexmkrc',
      ]),
    );
    expect(readOnly).not.toContain('/etc');
    expect(readOnly).not.toContain('/');
    expect(args[args.indexOf('--chdir') + 1]).toBe('/project/thesis');
  });

  it('rebuilds a minimal environment', () => {
    const env = Object.fromEntries(triples(args, '--setenv'));
    expect(env).toMatchObject({
      HOME: '/tmp',
      openout_any: 'p',
      max_print_line: '10000',
      TEXMFHOME: '/texmf',
      PATH: '/usr/local/texlive/2026/bin/x86_64-linux:/usr/bin:/bin',
    });
    expect(Object.keys(env)).not.toContain('S3_SECRET_ACCESS_KEY');
  });

  it('mounts the caches after /tmp, and applies the process limits', () => {
    expect(args.indexOf('/tmp/par')).toBeGreaterThan(args.indexOf('/tmp'));
    const command = args.slice(args.indexOf('prlimit'));
    expect(command).toEqual([
      'prlimit',
      `--as=${String(2 * 1024 ** 3)}`,
      '--nproc=64',
      `--fsize=${String(500 * 1024 ** 2)}`,
      '--core=0',
      '--',
      'latexmk',
      'main.tex',
    ]);
    expect(
      bwrapArgs(paths, limits, '', ['x'])[
        bwrapArgs(paths, limits, '', ['x']).indexOf('--chdir') + 1
      ],
    ).toBe('/project');
  });
});

describe('directorySize', () => {
  it('adds regular files below a directory, ignoring links', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'galley-size-'));
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'a'), '12345');
    await writeFile(join(dir, 'sub', 'b'), '123');
    await symlink('/etc/hostname', join(dir, 'link'));
    expect(await directorySize(dir)).toBe(8);
    expect(await directorySize(join(dir, 'missing'))).toBe(0);
  });
});
