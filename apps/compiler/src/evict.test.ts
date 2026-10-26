import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enforceQuota, recordSize } from './evict.js';

const ids = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
];

describe('enforceQuota', () => {
  it('evicts the least recently used directories, sparing busy ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'galley-evict-'));
    for (const [index, id] of ids.entries()) {
      const dir = join(root, id);
      await mkdir(dir);
      await writeFile(join(dir, 'data'), 'x'.repeat(1000));
      expect(await recordSize(dir)).toBe(1000);
      const time = new Date(Date.UTC(2026, 0, index + 1));
      await utimes(dir, time, time);
    }
    await mkdir(join(root, 'not-a-project'));
    await mkdir(join(root, '00000000-0000-0000-0000-00000000000f'));

    const evicted = await enforceQuota(root, 1500, (id) => Promise.resolve(id === ids[0]));
    // The oldest is busy, so the next two go until the total fits.
    expect(evicted).toEqual([ids[1], ids[2]]);
    expect((await stat(join(root, ids[0] ?? ''))).isDirectory()).toBe(true);
    expect(await enforceQuota(root, 1500, () => Promise.resolve(false))).toEqual([]);
  });
});
