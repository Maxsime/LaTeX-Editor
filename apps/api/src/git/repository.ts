import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiConfig } from '../config.js';
import { git } from './run.js';

/** The only branch of a project's repository. */
export const MAIN_REF = 'refs/heads/main';

const HOOK_SCRIPT = fileURLToPath(new URL('../../hooks/pre-receive.mjs', import.meta.url));

/** Repositories configured by this process, so that it is done once each. */
const configured = new Set<string>();

/** Directory of a project's bare repository, relative to `GIT_DATA_DIR`. */
export function repositoryName(projectId: string): string {
  return `${projectId}.git`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Creates the project's bare repository if needed and makes sure it carries
 * the current settings and push hook.
 *
 * @returns the repository's path.
 */
export async function ensureRepository(config: ApiConfig, projectId: string): Promise<string> {
  const path = join(config.GIT_DATA_DIR, repositoryName(projectId));
  if (configured.has(path)) return path;
  const exists = await access(join(path, 'HEAD')).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await mkdir(config.GIT_DATA_DIR, { recursive: true });
    await git(path, ['init', '--quiet', '--bare', '--initial-branch=main', path]);
  }
  const settings: [string, string][] = [
    // Pushes only move main forward; history on the server is never rewritten.
    ['receive.denyNonFastForwards', 'true'],
    ['receive.denyDeletes', 'true'],
    ['receive.fsckObjects', 'true'],
    ['receive.maxInputSize', String(config.GIT_MAX_PUSH_MB * 1024 * 1024)],
    ['http.receivepack', 'true'],
  ];
  for (const [key, value] of settings) await git(path, ['config', key, value]);
  // The hook names the running Node binary and script, which change with the image.
  const hook = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(HOOK_SCRIPT)}\n`;
  const hookPath = join(path, 'hooks', 'pre-receive');
  const current = await readFile(hookPath, 'utf8').catch(() => null);
  if (current !== hook) {
    await mkdir(join(path, 'hooks'), { recursive: true });
    await writeFile(hookPath, hook, { mode: 0o755 });
  }
  configured.add(path);
  return path;
}

/** The commit `main` points to, or `null` in an empty repository. */
export async function mainCommit(path: string): Promise<string | null> {
  const out = await git(path, ['rev-parse', '--verify', '--quiet', `${MAIN_REF}^{commit}`]).catch(
    () => null,
  );
  return out === null ? null : out.toString('utf8').trim();
}
