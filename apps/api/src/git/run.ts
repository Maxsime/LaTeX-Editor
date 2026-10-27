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

/**
 * Runs a Git plumbing command on a bare repository.
 *
 * @returns its standard output.
 * @throws {GitError} when it exits with a non-zero status.
 */
export function git(
  gitDir: string,
  args: readonly string[],
  options: { input?: Uint8Array | string; env?: Record<string, string> } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env: gitEnvironment({ GIT_DIR: gitDir, ...options.env }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new GitError(args, code, Buffer.concat(err).toString('utf8')));
    });
    // A command that does not read its input closes the pipe early; that is fine.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
  });
}
