import { spawn } from 'node:child_process';

/**
 * Environment of every Git process: no user or system configuration, no
 * prompts, and nothing from the API's own environment (secrets included).
 */
export function gitEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/nonexistent',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args[0] ?? ''} exited with ${String(code)}: ${stderr.slice(0, 500)}`);
  }
}

export interface GitOptions {
  input?: Uint8Array | string;
  env?: Record<string, string>;
  /** Kills the command after this long (network commands). */
  timeoutMs?: number;
  /**
   * Largest file the command may write, enforced by the kernel (`ulimit -f`):
   * bounds the pack a fetch downloads, which Git itself does not limit.
   */
  maxFileBytes?: number;
  /** Exit statuses other than 0 that are answers, not failures (`merge-tree` exits 1 on conflicts). */
  allowExit?: readonly number[];
}

/**
 * Runs a Git command on a bare repository.
 *
 * @returns its standard output.
 * @throws {GitError} when it exits with a status not allowed, or times out.
 */
export function git(
  gitDir: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<Buffer> {
  return gitWithStatus(gitDir, args, options).then(({ stdout }) => stdout);
}

/** {@link git}, also returning the exit status, one of 0 and `allowExit`. */
export function gitWithStatus(
  gitDir: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<{ stdout: Buffer; code: number }> {
  return new Promise((resolve, reject) => {
    const env = gitEnvironment({ GIT_DIR: gitDir, ...options.env });
    // The limit is in 512-byte blocks; the shell applies it, then becomes Git.
    const child =
      options.maxFileBytes === undefined
        ? spawn('git', args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(
            'sh',
            [
              '-c',
              'ulimit -f "$0" && exec git "$@"',
              String(Math.ceil(options.maxFileBytes / 512)),
              ...args,
            ],
            { env, stdio: ['pipe', 'pipe', 'pipe'] },
          );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!timedOut && code !== null && (code === 0 || options.allowExit?.includes(code))) {
        resolve({ stdout: Buffer.concat(out), code });
      } else {
        const stderr = timedOut ? 'timed out' : Buffer.concat(err).toString('utf8');
        reject(new GitError(args, code, stderr));
      }
    });
    // A command that does not read its input closes the pipe early; that is fine.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
  });
}
