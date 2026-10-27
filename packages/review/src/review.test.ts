import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  acceptAll,
  acceptSuggestion,
  acceptedText,
  encodePosition,
  parseEntry,
  rejectAll,
  resolveRanges,
  rejectSuggestion,
  RANGES_KEY,
  suggestChanges,
  suggestionsOf,
  type TextChange,
} from './index.js';

let counter = 0;

function documentWith(content: string) {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  const ranges = doc.getMap<unknown>(RANGES_KEY);
  text.insert(0, content);
  return { doc, text, ranges };
}

function suggest(
  target: ReturnType<typeof documentWith>,
  author: string,
  ...changes: TextChange[]
): void {
  suggestChanges(
    target.text,
    target.ranges,
    {
      author,
      now: 1_000 + counter,
      newId: () => `s${String(++counter)}`,
    },
    changes,
  );
}

describe('suggestions', () => {
  it('shows insertions in the text and keeps the accepted text', () => {
    const d = documentWith('Le chat dort.');
    suggest(d, 'r', { from: 7, to: 7, insert: ' noir' });
    expect(d.text.toJSON()).toBe('Le chat noir dort.');
    expect(acceptedText(d.text, d.ranges)).toBe('Le chat dort.');
    expect(suggestionsOf(d.text, d.ranges)).toEqual([
      expect.objectContaining({ kind: 'insert', author: 'r', from: 7, to: 12 }),
    ]);
  });

  it('extends a suggestion while typing, from either end', () => {
    const d = documentWith('ab');
    suggest(d, 'r', { from: 1, to: 1, insert: 'x' });
    suggest(d, 'r', { from: 2, to: 2, insert: 'y' });
    suggest(d, 'r', { from: 1, to: 1, insert: 'w' });
    suggest(d, 'r', { from: 2, to: 2, insert: 'z' });
    expect(d.text.toJSON()).toBe('awzxyb');
    expect(suggestionsOf(d.text, d.ranges)).toHaveLength(1);
    expect(acceptedText(d.text, d.ranges)).toBe('ab');
  });

  it('records deletions of accepted text and merges repeated keys', () => {
    const d = documentWith('abcdef');
    suggest(d, 'r', { from: 3, to: 4, insert: '' }); // Delete "d"
    suggest(d, 'r', { from: 2, to: 3, insert: '' }); // Backspace "c"
    suggest(d, 'r', { from: 2, to: 3, insert: '' }); // Delete "e"
    expect(d.text.toJSON()).toBe('abf');
    const suggestions = suggestionsOf(d.text, d.ranges);
    expect(suggestions).toEqual([expect.objectContaining({ kind: 'delete', text: 'cde', pos: 2 })]);
    expect(acceptedText(d.text, d.ranges)).toBe('abcdef');
  });

  it('really removes text from one’s own insertion, and keeps others’ deletions apart', () => {
    const d = documentWith('abc');
    suggest(d, 'r', { from: 1, to: 1, insert: 'XY' });
    suggest(d, 'r', { from: 1, to: 4, insert: '' }); // "XYb": own insertion and accepted "b"
    expect(d.text.toJSON()).toBe('ac');
    expect(suggestionsOf(d.text, d.ranges)).toEqual([
      expect.objectContaining({ kind: 'delete', text: 'b' }),
    ]);
    suggest(d, 's', { from: 0, to: 1, insert: '' });
    expect(suggestionsOf(d.text, d.ranges)).toHaveLength(2);
    expect(acceptedText(d.text, d.ranges)).toBe('abc');
  });

  it('accepts and rejects one suggestion at a time', () => {
    const d = documentWith('one two three');
    suggest(d, 'r', { from: 4, to: 7, insert: '2' });
    suggest(d, 'r', { from: 0, to: 0, insert: '> ' });
    expect(d.text.toJSON()).toBe('> one 2 three');
    const [prefix, deletion, replacement] = suggestionsOf(d.text, d.ranges);
    expect([prefix?.kind, deletion?.kind, replacement?.kind]).toEqual([
      'insert',
      'delete',
      'insert',
    ]);
    rejectSuggestion(d.text, d.ranges, prefix?.id ?? '');
    expect(d.text.toJSON()).toBe('one 2 three');
    rejectSuggestion(d.text, d.ranges, deletion?.id ?? '');
    expect(d.text.toJSON()).toBe('one two2 three');
    acceptSuggestion(d.ranges, replacement?.id ?? '');
    expect(d.text.toJSON()).toBe('one two2 three');
    expect(suggestionsOf(d.text, d.ranges)).toEqual([]);
  });

  it('restores coincident deletions in their original order, whichever goes first', () => {
    for (const first of [0, 1]) {
      const d = documentWith('abc');
      suggest(d, 'r', { from: 1, to: 2, insert: '' }); // "b"
      suggest(d, 's', { from: 0, to: 1, insert: '' }); // "a", by someone else
      expect(d.text.toJSON()).toBe('c');
      expect(acceptedText(d.text, d.ranges)).toBe('abc');
      const deletions = suggestionsOf(d.text, d.ranges);
      expect(deletions.map((range) => range.kind)).toEqual(['delete', 'delete']);
      const order = first === 0 ? deletions : [...deletions].reverse();
      for (const range of order) {
        rejectSuggestion(d.text, d.ranges, range.id);
        expect(acceptedText(d.text, d.ranges)).toBe('abc');
      }
      expect(d.text.toJSON()).toBe('abc');
    }
  });

  it('accepts or rejects everything, or one author’s suggestions', () => {
    const d = documentWith('alpha beta');
    suggest(d, 'r', { from: 0, to: 5, insert: 'ALPHA' });
    suggest(d, 's', { from: 10, to: 10, insert: '!' });
    const reject = documentWith('');
    Y.applyUpdate(reject.doc, Y.encodeStateAsUpdate(d.doc));
    acceptAll(d.ranges, 's');
    expect(acceptedText(d.text, d.ranges)).toBe('alpha beta!');
    acceptAll(d.ranges);
    expect(d.text.toJSON()).toBe('ALPHA beta!');
    rejectAll(reject.text, reject.ranges);
    expect(reject.text.toJSON()).toBe('alpha beta');
    expect(suggestionsOf(reject.text, reject.ranges)).toEqual([]);
  });

  it('leaves comment anchors to their own logic', () => {
    const d = documentWith('text');
    d.ranges.set('thread', { kind: 'comment', author: 'r', start: null, end: null });
    d.ranges.set('junk', { kind: 'other' });
    acceptSuggestion(d.ranges, 'thread');
    rejectSuggestion(d.text, d.ranges, 'thread');
    acceptAll(d.ranges);
    expect(d.ranges.has('thread')).toBe(true);
    expect(acceptedText(d.text, d.ranges)).toBe('text');
  });

  it('reads only well-formed entries', () => {
    expect(parseEntry(null)).toBeNull();
    expect(parseEntry({ kind: 'insert', author: 'r', at: 1, runs: [[1, 0, 0]] })).toBeNull();
    expect(parseEntry({ kind: 'insert', author: 'r', at: 1, runs: [[1, -1, 2]] })).toBeNull();
    expect(parseEntry({ kind: 'insert', author: 'r', at: 1, runs: 'x' })).toBeNull();
    expect(parseEntry({ kind: 'delete', author: 'r', at: 1, runs: [[1, 0, '']] })).toBeNull();
    expect(parseEntry({ kind: 'delete', author: 'r', at: 1, runs: [[1, 0]] })).toBeNull();
    expect(parseEntry({ kind: 'delete', author: 'r', at: 1, runs: {} })).toBeNull();
    expect(parseEntry({ kind: 'delete', author: 'r', at: 1, runs: [[1, 0, 'ab']] })).toEqual({
      kind: 'delete',
      author: 'r',
      at: 1,
      runs: [[1, 0, 'ab']],
    });
  });

  it('places comments by their anchors and drops lost ones', () => {
    const d = documentWith('hello world');
    d.ranges.set('c1', {
      kind: 'comment',
      author: 'r',
      start: encodePosition(d.text, 6, 0),
      end: encodePosition(d.text, 11, -1),
    });
    d.ranges.set('lost', { kind: 'comment', author: 'r', start: 'nowhere', end: null });
    d.ranges.set('forged', { kind: 'comment', author: 'r', start: { tname: 1 }, end: {} });
    d.text.insert(0, '> ');
    expect(resolveRanges(d.text, d.ranges)).toEqual([
      { id: 'c1', kind: 'comment', author: 'r', from: 8, to: 13 },
    ]);
  });
});
