import type { OutlineEntry } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import { activeOutlineIndex, relativeDepths } from './outline.js';

const entry = (fileId: string, line: number, depth = 2): OutlineEntry => ({
  fileId,
  path: `${fileId}.tex`,
  line,
  level: 'section',
  depth,
  title: `${fileId}:${String(line)}`,
  starred: false,
});

describe('activeOutlineIndex', () => {
  const entries = [entry('main', 3), entry('ch1', 1), entry('ch1', 20), entry('main', 10)];

  it('finds the last heading above the cursor in the active file', () => {
    expect(activeOutlineIndex(entries, 'ch1', 25)).toBe(2);
    expect(activeOutlineIndex(entries, 'ch1', 5)).toBe(1);
    expect(activeOutlineIndex(entries, 'main', 9)).toBe(0);
    expect(activeOutlineIndex(entries, 'main', 2)).toBe(-1);
    expect(activeOutlineIndex(entries, null, 2)).toBe(-1);
  });
});

describe('relativeDepths', () => {
  it('indents from the shallowest heading', () => {
    expect(relativeDepths([entry('a', 1, 2), entry('a', 2, 3), entry('a', 3, 4)])).toEqual([
      0, 1, 2,
    ]);
    expect(relativeDepths([])).toEqual([]);
  });
});
