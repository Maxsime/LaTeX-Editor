import { EditorState } from '@codemirror/state';
import { RANGES_KEY, resolveRanges, suggestChanges } from '@galley/review';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { lineColumnAt } from '../lib/review.js';
import { anchorComment, changesOf, reviewMarks } from './review.js';

describe('changesOf', () => {
  it('composes several transactions into changes on the text before them', () => {
    const start = EditorState.create({ doc: 'abcdef' });
    const first = start.update({ changes: { from: 1, to: 2, insert: 'XY' } });
    const second = first.state.update({ changes: { from: 5, to: 7 } });
    expect(changesOf(start.doc, [first, second])).toEqual([
      { from: 1, to: 2, insert: 'XY' },
      { from: 4, to: 6, insert: '' },
    ]);
  });
});

describe('reviewMarks', () => {
  it('draws insertions, deletions and open threads only, in position order', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    const ranges = doc.getMap<unknown>(RANGES_KEY);
    text.insert(0, 'one two three');
    anchorComment(text, ranges, 'open', 'u', 0, 3);
    anchorComment(text, ranges, 'done', 'u', 4, 7);
    let n = 0;
    suggestChanges(text, ranges, { author: 'u', now: 1, newId: () => `s${String(++n)}` }, [
      { from: 4, to: 8, insert: '' },
      { from: 13, to: 13, insert: '!' },
    ]);
    const marks = reviewMarks(
      resolveRanges(text, ranges),
      text.length,
      (id) => id === 'open',
      (range) => range.kind,
    );
    expect(marks).toEqual([
      { type: 'comment', from: 0, to: 3, id: 'open' },
      { type: 'delete', at: 4, text: 'two ', id: 's1', title: 'delete' },
      { type: 'insert', from: 9, to: 10, id: 's2', title: 'insert' },
    ]);
    // Positions past the editor's text (not caught up yet) are left out.
    expect(
      reviewMarks(resolveRanges(text, ranges), 5, () => true, () => '').map((mark) => mark.type),
    ).toEqual(['comment', 'delete']);
  });
});

describe('lineColumnAt', () => {
  it('turns an index into a line and column', () => {
    expect(lineColumnAt('ab\ncd\nef', 0)).toEqual({ line: 1, column: 0 });
    expect(lineColumnAt('ab\ncd\nef', 4)).toEqual({ line: 2, column: 1 });
    expect(lineColumnAt('ab\ncd\nef', 99)).toEqual({ line: 3, column: 2 });
  });
});
