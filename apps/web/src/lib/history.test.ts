import { describe, expect, it } from 'vitest';
import { foldDiff, lineDiff } from './history.js';

describe('lineDiff', () => {
  it('numbers removed lines on the old side and added ones on the new side', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { kind: 'same', text: 'a', line: 1 },
      { kind: 'removed', text: 'b', line: 2 },
      { kind: 'added', text: 'B', line: 2 },
      { kind: 'same', text: 'c', line: 3 },
      { kind: 'added', text: 'd', line: 4 },
    ]);
  });

  it('treats a missing side as empty', () => {
    expect(lineDiff('', 'x\n')).toEqual([{ kind: 'added', text: 'x', line: 1 }]);
    expect(lineDiff('x', '')).toEqual([{ kind: 'removed', text: 'x', line: 1 }]);
  });
});

describe('foldDiff', () => {
  it('keeps three lines of context and folds the rest', () => {
    const before = Array.from({ length: 20 }, (_, index) => `l${String(index + 1)}`).join('\n');
    const after = before.replace('l10', 'ten');
    const folded = foldDiff(lineDiff(`${before}\n`, `${after}\n`));
    expect(folded[0]).toEqual({ kind: 'folded', count: 6 });
    expect(folded.filter((line) => line.kind === 'same')).toHaveLength(6);
    expect(folded.at(-1)).toEqual({ kind: 'folded', count: 7 });
  });

  it('folds identical texts into a single count', () => {
    expect(foldDiff(lineDiff('a\nb\n', 'a\nb\n'))).toEqual([{ kind: 'folded', count: 2 }]);
  });
});
