import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  projectPathToSynctexInput,
  type SynctexBox,
  type SynctexJob,
  type SynctexResult,
  type SynctexSource,
} from '@galley/shared';

/** Where the cached SyncTeX data of a compilation is seen inside the sandbox. */
const SANDBOX_DATA = '/out';

/** Wall-clock limit of one query; the binary answers in a few milliseconds. */
const SYNCTEX_TIMEOUT_MS = 5_000;
/** Address space of the query, enough for the SyncTeX data of a long thesis. */
const SYNCTEX_MEMORY_BYTES = 1024 * 1024 * 1024;
/** Most output read from the binary; a `view` of a long paragraph lists a few dozen boxes. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Reads the record of one SyncTeX result: `Key:value` lines between the markers. */
function results(stdout: string): Map<string, string>[] {
  const records: Map<string, string>[] = [];
  let inside = false;
  let current: Map<string, string> | null = null;
  for (const line of stdout.split('\n')) {
    if (line === 'SyncTeX result begin') {
      inside = true;
      continue;
    }
    if (line === 'SyncTeX result end') break;
    if (!inside) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    // Each result starts with the output file it refers to.
    if (key === 'Output') {
      current = new Map();
      records.push(current);
    }
    current?.set(key, value);
  }
  return records;
}

function numberOf(record: Map<string, string>, key: string): number | null {
  const raw = record.get(key);
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Parses the output of `synctex edit`: the source position under a point. */
export function parseSynctexEdit(stdout: string): SynctexSource | null {
  for (const record of results(stdout)) {
    const input = record.get('Input');
    const line = numberOf(record, 'Line');
    if (input === undefined || input === '' || line === null || line < 1) continue;
    const column = numberOf(record, 'Column');
    return { input, line, column: column !== null && column >= 0 ? column : null };
  }
  return null;
}

/**
 * Parses the output of `synctex view`: the boxes a source line produced. SyncTeX
 * gives each box by its left edge `h`, its baseline `v`, its width `W` and its
 * height `H` above the baseline; boxes are returned by their top-left corner.
 */
export function parseSynctexView(stdout: string): SynctexBox[] {
  const boxes: SynctexBox[] = [];
  const seen = new Set<string>();
  for (const record of results(stdout)) {
    const page = numberOf(record, 'Page');
    const h = numberOf(record, 'h');
    const v = numberOf(record, 'v');
    const width = numberOf(record, 'W');
    const height = numberOf(record, 'H');
    if (page === null || h === null || v === null || width === null || height === null) continue;
    const box = { page, x: h, y: v - height, width, height };
    const key = `${String(page)}:${box.x.toFixed(2)}:${box.y.toFixed(2)}:${width.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    boxes.push(box);
  }
  return boxes;
}

/** Name of the PDF a SyncTeX file describes; the binary locates the data from it. */
function pdfNameOf(synctexFile: string): string {
  return `${synctexFile.slice(0, -'.synctex.gz'.length)}.pdf`;
}

/** Arguments of the `synctex` binary for a job, with paths as seen in the sandbox. */
export function synctexArgs(job: SynctexJob): string[] {
  const pdf = `${SANDBOX_DATA}/${pdfNameOf(job.synctexFile)}`;
  if (job.kind === 'edit') {
    return ['edit', '-o', `${String(job.page)}:${String(job.x)}:${String(job.y)}:${pdf}`];
  }
  const input = projectPathToSynctexInput(job.file);
  return ['view', '-i', `${String(job.line)}:${String(job.column)}:${input}`, '-o', pdf];
}

/**
 * Arguments of `bwrap` for a query. The SyncTeX data comes from an untrusted
 * compilation, so the parser runs as confined as TeX: no network, no writable
 * file system but a small `/tmp`, only the cached data of this compilation.
 */
export function synctexSandboxArgs(texliveBin: string, dataDir: string, argv: string[]): string[] {
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    ...['--ro-bind', '/usr', '/usr'],
    ...['--symlink', 'usr/bin', '/bin'],
    ...['--symlink', 'usr/lib', '/lib'],
    ...['--symlink', 'usr/lib64', '/lib64'],
    ...['--ro-bind', texliveBin, texliveBin],
    ...['--proc', '/proc'],
    ...['--dev', '/dev'],
    ...['--size', String(16 * 1024 * 1024), '--tmpfs', '/tmp'],
    ...['--ro-bind', dataDir, SANDBOX_DATA],
    ...['--chdir', SANDBOX_DATA],
    ...['--setenv', 'PATH', `${texliveBin}:/usr/bin:/bin`],
    '--',
    'prlimit',
    `--as=${String(SYNCTEX_MEMORY_BYTES)}`,
    '--nproc=4',
    '--fsize=0',
    '--core=0',
    '--',
    join(texliveBin, 'synctex'),
    ...argv,
  ];
}

/** Runs a command with an empty environment and returns its standard output. */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      if (size >= MAX_OUTPUT_BYTES) return;
      chunks.push(chunk);
      size += chunk.length;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), SYNCTEX_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // SyncTeX exits non-zero when nothing matches; the output tells either way.
    child.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** Opens a file published by a compilation. */
export type OutputFetcher = (compileId: string, name: string) => Promise<Readable>;

export interface SynctexEnvironment {
  /** Folder of the local copies of published SyncTeX data, one sub-folder per compilation. */
  cacheDir: string;
  /** Most compilations kept in the cache. */
  maxEntries: number;
  /** Folder of the TeX Live binaries. */
  texliveBin: string;
  fetchOutput: OutputFetcher;
  /** Sandbox binary; replaceable in tests. */
  bwrap?: string;
}

/** Downloads the SyncTeX data of a compilation unless the cache already holds it. */
async function ensureCached(env: SynctexEnvironment, job: SynctexJob): Promise<string> {
  const dir = join(env.cacheDir, job.compileId);
  const file = join(dir, job.synctexFile);
  try {
    if ((await stat(file)).isFile()) {
      const now = new Date();
      // The modification time of the folder orders the entries for eviction.
      await utimes(dir, now, now);
      return dir;
    }
  } catch {
    // Not cached yet.
  }
  await mkdir(dirname(file), { recursive: true });
  // Two queries may download the same file at once; each writes its own copy.
  const partial = `${file}.${randomUUID()}.partial`;
  await pipeline(await env.fetchOutput(job.compileId, job.synctexFile), createWriteStream(partial));
  await rename(partial, file);
  await evict(env);
  return dir;
}

/** Deletes the least recently used compilations beyond the cache size. */
async function evict(env: SynctexEnvironment): Promise<void> {
  const entries = await readdir(env.cacheDir, { withFileTypes: true });
  const dirs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(env.cacheDir, entry.name);
        return { path, used: (await stat(path)).mtimeMs };
      }),
  );
  dirs.sort((a, b) => b.used - a.used);
  for (const { path } of dirs.slice(env.maxEntries)) {
    await rm(path, { recursive: true, force: true });
  }
}

/** Answers a SyncTeX job from the published data of its compilation (SPEC §6.5). */
export async function runSynctex(env: SynctexEnvironment, job: SynctexJob): Promise<SynctexResult> {
  const dir = await ensureCached(env, job);
  const stdout = await run(
    env.bwrap ?? 'bwrap',
    synctexSandboxArgs(env.texliveBin, dir, synctexArgs(job)),
  );
  return job.kind === 'edit'
    ? { kind: 'edit', source: parseSynctexEdit(stdout) }
    : { kind: 'view', boxes: parseSynctexView(stdout) };
}
