import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Installation directory and release of the TeX Live the worker runs. */
export interface TexLiveInfo {
  /** e.g. `/usr/local/texlive/2026`. */
  dir: string;
  /** e.g. `TeX Live 2026`. */
  release: string;
}

/** Reads the release from the banner of `tex --version`. */
export function releaseFromBanner(banner: string): string {
  return /\((TeX Live \d{4}[^)]*)\)/.exec(banner)?.[1] ?? 'TeX Live';
}

/** Asks kpathsea where TeX Live lives and which release it is. */
export async function detectTexLive(): Promise<TexLiveInfo> {
  const [{ stdout: dir }, { stdout: banner }] = await Promise.all([
    run('kpsewhich', ['-var-value', 'SELFAUTOPARENT']),
    run('tex', ['--version']),
  ]);
  return { dir: dir.trim(), release: releaseFromBanner(banner) };
}
