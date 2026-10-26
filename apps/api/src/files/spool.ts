import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Raised when a stream carries more bytes than its limit allows. */
export class SizeLimitError extends Error {
  constructor(readonly limit: number) {
    super(`content exceeds ${String(limit)} bytes`);
    this.name = 'SizeLimitError';
  }
}

/** Counting, hashing stage that aborts as soon as the real size exceeds `maxBytes`. */
export function meter(maxBytes: number): Transform & { size: () => number; digest: () => string } {
  const hash = createHash('sha256');
  let size = 0;
  const stage = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new SizeLimitError(maxBytes));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  let digest: string | undefined;
  return Object.assign(stage, {
    size: () => size,
    digest: () => (digest ??= hash.digest('hex')),
  });
}

/** Writes `source` to `target`, returning its real size and SHA-256. */
export async function spool(
  source: Readable,
  target: string,
  maxBytes: number,
): Promise<{ size: number; hash: string }> {
  const stage = meter(maxBytes);
  await pipeline(source, stage, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  return { size: stage.size(), hash: stage.digest() };
}

/** A private scratch directory, removed with everything in it by `cleanup`. */
export interface ScratchDir {
  path: string;
  file: (name: string) => string;
  cleanup: () => Promise<void>;
}

export async function createScratchDir(root: string): Promise<ScratchDir> {
  const path = await mkdtemp(join(root, 'galley-'));
  let counter = 0;
  return {
    path,
    // Generated names only: user-supplied names never reach the filesystem.
    file: (suffix) => join(path, `${String(counter++)}.${suffix}`),
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}
