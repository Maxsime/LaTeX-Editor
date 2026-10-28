import { describe, expect, it } from 'vitest';
import { lineChanges } from './textdiff.js';

function apply(text: string, changes: ReturnType<typeof lineChanges>): string {
  let result = text;
  for (const change of [...changes].reverse()) {
    result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  }
  return result;
}

describe('lineChanges', () => {
  it('touches only the lines that differ', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nB\nc\nd\ne\n';
    const changes = lineChanges(before, after);
    expect(changes).toEqual([
      { from: 2, to: 4, insert: 'B\n' },
      { from: 8, to: 8, insert: 'e\n' },
    ]);
    expect(apply(before, changes)).toBe(after);
  });

  it('handles reordered blocks and identical texts', () => {
    const before = '@b{2,\n}\n\n@a{1,\n}\n';
    const after = '@a{1,\n}\n\n@b{2,\n}\n';
    expect(apply(before, lineChanges(before, after))).toBe(after);
    expect(lineChanges(before, before)).toEqual([]);
  });
});
