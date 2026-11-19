import type { ImportProjectResponse } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import { type ImportItem, initialItems, isZipFile, runImports } from './import-batch.js';

function response(name: string): ImportProjectResponse {
  // Only the name matters to these tests; the rest of the summary is not read.
  return { project: { name }, warnings: [] } as unknown as ImportProjectResponse;
}

describe('batch import', () => {
  it('recognises zip files by their extension, whatever the case', () => {
    expect(isZipFile({ name: 'Rapport.zip' })).toBe(true);
    expect(isZipFile({ name: 'THESE.ZIP' })).toBe(true);
    expect(isZipFile({ name: 'main.tex' })).toBe(false);
    expect(isZipFile({ name: 'archive.zip.txt' })).toBe(false);
  });

  it('skips files that are not zips from the start', () => {
    expect(initialItems([{ name: 'a.zip' }, { name: 'notes.pdf' }])).toEqual([
      { fileName: 'a.zip', status: 'pending' },
      { fileName: 'notes.pdf', status: 'skipped' },
    ]);
  });

  it('imports each zip as its own project, in order, and goes on after a failure', async () => {
    const calls: string[] = [];
    const refused = new Error('refused');
    const snapshots: (readonly ImportItem[])[] = [];
    const items = await runImports(
      [{ name: 'a.zip' }, { name: 'bad.zip' }, { name: 'skip.txt' }, { name: 'c.zip' }],
      (file) => {
        calls.push(file.name);
        return file.name === 'bad.zip'
          ? Promise.reject(refused)
          : Promise.resolve(response(file.name.replace('.zip', '')));
      },
      (next) => snapshots.push(next),
    );
    expect(calls).toEqual(['a.zip', 'bad.zip', 'c.zip']);
    expect(items.map((item) => item.status)).toEqual(['done', 'failed', 'skipped', 'done']);
    expect(items[1]).toEqual({ fileName: 'bad.zip', status: 'failed', error: refused });
    const last = items[3];
    expect(last?.status === 'done' && last.result.project.name).toBe('c');
    // One import at a time: never two archives running together.
    for (const snapshot of snapshots) {
      expect(snapshot.filter((item) => item.status === 'running').length).toBeLessThanOrEqual(1);
    }
    expect(snapshots.at(-1)).toBe(items);
  });
});
