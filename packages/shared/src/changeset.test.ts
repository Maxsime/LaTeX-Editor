import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyEdits, type LocatableHunk, locateHunk, realignHunks } from './changeset.js';

function hunk(
  text: string,
  start: number,
  length: number,
  replacement: string,
  id = 'h',
): LocatableHunk {
  return {
    id,
    start,
    original: text.slice(start, start + length),
    replacement,
    before: text.slice(Math.max(0, start - 10), start),
    after: text.slice(start + length, start + length + 10),
  };
}

describe('locateHunk', () => {
  const text = 'Le chat dort. Le chien court. Le chat mange.';

  it('keeps a hunk whose text is still at its place', () => {
    expect(locateHunk(text, hunk(text, 3, 4, 'lion'))).toBe(3);
  });

  it('follows a hunk moved by an edit before it', () => {
    const h = hunk(text, 17, 5, 'loup');
    expect(locateHunk(`Bonjour. ${text}`, h)).toBe(26);
  });

  it('tells repeated text apart by its surroundings', () => {
    const h = hunk(text, 33, 4, 'lion');
    expect(locateHunk(`XX${text}`, h)).toBe(35);
  });

  it('reports a conflict when the text is gone', () => {
    expect(locateHunk('Tout a changé.', hunk(text, 3, 4, 'lion'))).toBeNull();
  });

  it('places a pure insertion by its surroundings', () => {
    const h = hunk(text, 13, 0, ' Il pleut.');
    expect(locateHunk(text, h)).toBe(13);
    expect(locateHunk(`Titre. ${text}`, h)).toBe(20);
    expect(locateHunk('autre chose', h)).toBeNull();
  });

  it('accepts an insertion into an empty file', () => {
    expect(
      locateHunk('', { id: 'h', start: 0, original: '', replacement: 'x', before: '', after: '' }),
    ).toBe(0);
    expect(
      locateHunk('', { id: 'h', start: 3, original: '', replacement: 'x', before: '', after: '' }),
    ).toBeNull();
  });
});

describe('realignHunks', () => {
  it('applies several hunks of one file from the end backwards', () => {
    const text = 'alpha beta gamma';
    const { edits, results } = realignHunks(text, [
      hunk(text, 0, 5, 'ALPHA', 'a'),
      hunk(text, 11, 5, 'GAMMA', 'c'),
    ]);
    expect([...results.values()]).toEqual(['applied', 'applied']);
    expect(edits.map((edit) => edit.id)).toEqual(['c', 'a']);
    expect(applyEdits(text, edits)).toBe('ALPHA beta GAMMA');
  });

  it('marks overlapping hunks as conflicts', () => {
    const text = 'alpha beta gamma';
    const { results } = realignHunks(text, [
      hunk(text, 0, 10, 'x', 'a'),
      hunk(text, 6, 4, 'y', 'b'),
      hunk(text, 0, 0, 'z', 'c'),
    ]);
    expect(results.get('a')).toBe('applied');
    expect(results.get('b')).toBe('conflict');
    expect(results.get('c')).toBe('conflict');
  });

  it('applies non-overlapping hunks on unchanged text exactly', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.array(fc.tuple(fc.nat(), fc.nat(20), fc.string({ maxLength: 10 })), { maxLength: 6 }),
        (text, specs) => {
          // Cut the text into disjoint spans, one per spec, in order.
          const hunks: LocatableHunk[] = [];
          let cursor = 0;
          for (const [index, [gap, length, replacement]] of specs.entries()) {
            const start = Math.min(text.length, cursor + (gap % 20));
            const end = Math.min(text.length, start + length);
            if (end === start) continue;
            hunks.push(hunk(text, start, end - start, replacement, String(index)));
            cursor = end;
          }
          const { edits, results } = realignHunks(text, hunks);
          for (const h of hunks) expect(results.get(h.id)).toBe('applied');
          let expected = text;
          for (const h of [...hunks].reverse()) {
            expected =
              expected.slice(0, h.start) +
              h.replacement +
              expected.slice(h.start + h.original.length);
          }
          expect(applyEdits(text, edits)).toBe(expected);
        },
      ),
    );
  });
});
