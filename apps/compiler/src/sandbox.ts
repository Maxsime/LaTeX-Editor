import { execFile, spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Resource limits of one compilation (SPEC §6.3). */
export interface SandboxLimits {
  timeoutMs: number;
  /** Address space of each process, in bytes. */
  memoryBytes: number;
  maxProcesses: number;
  /** Size of the output folder, and of any single file written. */
  maxOutputBytes: number;
}

/** Host directories the sandbox is built from. */
export interface SandboxPaths {
  /** TeX Live installation, e.g. `/usr/local/texlive/2026`. */
  texliveDir: string;
  /** Read-only assets baked into the image: passwd, group, latexmkrc, Biber cache. */
  assetsDir: string;
  /** Project sources, writable, seen as `/project`. */
  srcDir: string;
  /** Output and auxiliary files, writable, seen as `/out`. */
  outDir: string;
  /** Personal texmf tree, read-only, seen as `/texmf`; may not exist. */
  texmfDir: string;
}

/** Where the sandbox places the project and its outputs. */
export const SANDBOX_PROJECT = '/project';
export const SANDBOX_OUT = '/out';

/** Platform directory of the TeX Live binaries in the worker image. */
const TEXLIVE_ARCH = 'x86_64-linux';

/** Folder of the TeX Live binaries of an installation. */
export function texliveBinDir(texliveDir: string): string {
  return `${texliveDir}/bin/${TEXLIVE_ARCH}`;
}

/**
 * Arguments of `bwrap` running `argv` in a fresh sandbox: no network, own PID,
 * IPC, UTS, cgroup and user namespaces, a file system reduced to what TeX needs,
 * an environment rebuilt from scratch, and per-process limits set by prlimit.
 *
 * @param cwd Directory to run in, relative to the project root (`''` for the root).
 */
export function bwrapArgs(
  paths: SandboxPaths,
  limits: SandboxLimits,
  cwd: string,
  argv: readonly string[],
): string[] {
  const tl = paths.texliveDir;
  const assets = paths.assetsDir;
  const tmpBytes = String(Math.min(limits.maxOutputBytes, 512 * 1024 * 1024));
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    // System programs TeX relies on: Perl for latexmk, Python for minted, Ghostscript.
    ...['--ro-bind', '/usr', '/usr'],
    ...['--symlink', 'usr/bin', '/bin'],
    ...['--symlink', 'usr/lib', '/lib'],
    ...['--symlink', 'usr/lib64', '/lib64'],
    ...['--symlink', 'usr/sbin', '/sbin'],
    ...['--ro-bind', tl, tl],
    // A minimal /etc: fonts for XeTeX and a single unprivileged user.
    ...['--dir', '/etc'],
    ...['--ro-bind-try', '/etc/fonts', '/etc/fonts'],
    ...['--ro-bind-try', '/var/cache/fontconfig', '/var/cache/fontconfig'],
    ...['--ro-bind', join(assets, 'passwd'), '/etc/passwd'],
    ...['--ro-bind', join(assets, 'group'), '/etc/group'],
    ...['--ro-bind', join(assets, 'latexmkrc'), '/galley/latexmkrc'],
    ...['--proc', '/proc'],
    ...['--dev', '/dev'],
    ...['--size', tmpBytes, '--tmpfs', '/tmp'],
    // Caches warmed in the image, writable through a throw-away overlay. They must be
    // mounted after /tmp, or the tmpfs would hide them.
    ...['--overlay-src', join(assets, 'par-cache'), '--tmp-overlay', '/tmp/par'],
    ...['--overlay-src', join(tl, 'texmf-var'), '--tmp-overlay', '/tmp/texmf-var'],
    ...['--ro-bind-try', paths.texmfDir, '/texmf'],
    ...['--bind', paths.srcDir, SANDBOX_PROJECT],
    ...['--bind', paths.outDir, SANDBOX_OUT],
    ...['--chdir', cwd === '' ? SANDBOX_PROJECT : `${SANDBOX_PROJECT}/${cwd}`],
    ...['--setenv', 'PATH', `${texliveBinDir(tl)}:/usr/bin:/bin`],
    ...['--setenv', 'HOME', '/tmp'],
    ...['--setenv', 'TMPDIR', '/tmp'],
    ...['--setenv', 'LANG', 'C.UTF-8'],
    ...['--setenv', 'TEXMFHOME', '/texmf'],
    ...['--setenv', 'TEXMFVAR', '/tmp/texmf-var'],
    ...['--setenv', 'PAR_GLOBAL_TEMP', '/tmp/par'],
    // Writes only below the working and output directories.
    ...['--setenv', 'openout_any', 'p'],
    // Unwrapped log lines, so that file names and messages can be parsed.
    ...['--setenv', 'max_print_line', '10000'],
    ...['--setenv', 'error_line', '254'],
    ...['--setenv', 'half_error_line', '238'],
    '--',
    'prlimit',
    `--as=${String(limits.memoryBytes)}`,
    // Counted per user namespace since Linux 5.14, so it bounds this compilation only.
    `--nproc=${String(limits.maxProcesses)}`,
    `--fsize=${String(limits.maxOutputBytes)}`,
    '--core=0',
    '--',
    ...argv,
  ];
}

/** How a sandboxed run ended. */
export interface SandboxRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  /** The output folder outgrew its limit and the run was stopped. */
  outputExceeded: boolean;
  /** Combined stdout and stderr, cut to the first {@link MAX_CONSOLE_BYTES}. */
  console: string;
  durationMs: number;
}

const MAX_CONSOLE_BYTES = 1024 * 1024;
const OUTPUT_POLL_MS = 1_000;

/** Total size of the regular files below a directory, without following links. */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await lstat(path)).size;
  }
  return total;
}

/**
 * Runs a command in the sandbox and waits for it. bwrap itself starts with an
 * empty environment: it is PID 1 of the sandbox, so its own environment would
 * otherwise be readable in `/proc/1/environ`.
 */
export function runSandboxed(
  paths: SandboxPaths,
  limits: SandboxLimits,
  cwd: string,
  argv: readonly string[],
  signal?: AbortSignal,
): Promise<SandboxRun> {
  const started = Date.now();
  const child = spawn('bwrap', bwrapArgs(paths, limits, cwd, argv), {
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  let consoleBytes = 0;
  const collect = (chunk: Buffer) => {
    if (consoleBytes >= MAX_CONSOLE_BYTES) return;
    chunks.push(chunk.subarray(0, MAX_CONSOLE_BYTES - consoleBytes));
    consoleBytes += chunk.length;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  let timedOut = false;
  let cancelled = false;
  let outputExceeded = false;
  // Killing bwrap is enough: the sandbox's init dies with it (--die-with-parent),
  // and the kernel then kills every process of the PID namespace.
  const kill = () => child.kill('SIGKILL');
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, limits.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    kill();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const poll = setInterval(() => {
    void directorySize(paths.outDir).then((size) => {
      if (size > limits.maxOutputBytes) {
        outputExceeded = true;
        kill();
      }
    });
  }, OUTPUT_POLL_MS);

  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => {
      finish();
      reject(error);
    });
    child.on('close', (exitCode, exitSignal) => {
      finish();
      resolve({
        exitCode,
        signal: exitSignal,
        timedOut,
        cancelled,
        outputExceeded,
        console: Buffer.concat(chunks).toString('utf8'),
        durationMs: Date.now() - started,
      });
    });
  });
}

/** Arguments of the smallest sandbox: the namespaces of a compilation and a read-only `/usr`. */
export const SANDBOX_PROBE_ARGS = [
  '--unshare-all',
  '--die-with-parent',
  '--clearenv',
  '--ro-bind',
  '/usr',
  '/usr',
  '--symlink',
  'usr/bin',
  '/bin',
  '--symlink',
  'usr/lib',
  '/lib',
  '--symlink',
  'usr/lib64',
  '/lib64',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  '/usr/bin/true',
];

/**
 * Checks once at start that the host lets bwrap create its namespaces. A host
 * that forbids it (seccomp profile missing, AppArmor restricting user
 * namespaces) would otherwise fail every compilation with no output.
 *
 * @param command - The sandbox binary; replaceable in tests.
 * @throws Error carrying bwrap's own message.
 */
export function checkSandbox(command = 'bwrap'): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      SANDBOX_PROBE_ARGS,
      { env: {}, timeout: 10_000 },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`sandbox unavailable: ${stderr.trim() || error.message}`));
        else resolve();
      },
    );
  });
}
