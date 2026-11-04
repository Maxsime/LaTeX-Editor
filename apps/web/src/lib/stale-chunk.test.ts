import { describe, expect, it, vi } from 'vitest';
import { isStaleChunkError, reloadForStaleChunk, STALE_RELOAD_WINDOW_MS } from './stale-chunk.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('isStaleChunkError', () => {
  it('recognises the chunk loading errors of the main browsers', () => {
    expect(
      isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: /a.js')),
    ).toBe(true);
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isStaleChunkError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true);
  });

  it('leaves other errors alone', () => {
    expect(isStaleChunkError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isStaleChunkError('Failed to fetch dynamically imported module')).toBe(false);
  });
});

describe('reloadForStaleChunk', () => {
  it('reloads once, then lets the error page show within the window', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    let time = 1_000_000;
    const environment = { storage, now: () => time, reload };
    expect(reloadForStaleChunk(environment)).toBe(true);
    time += STALE_RELOAD_WINDOW_MS - 1;
    expect(reloadForStaleChunk(environment)).toBe(false);
    time += 1;
    expect(reloadForStaleChunk(environment)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads without storage, which would risk a loop', () => {
    const reload = vi.fn();
    expect(reloadForStaleChunk({ storage: null, now: () => 0, reload })).toBe(false);
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
    };
    expect(reloadForStaleChunk({ storage: blocked, now: () => 0, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
