import { TEXT_KEY } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocumentSizeGuard } from './limits.js';
import { InvalidUpdate } from './review.js';

function server(content: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText(TEXT_KEY).insert(0, content);
  return doc;
}

/** What a client holding a copy of `doc` sends after `change`. */
function updateFrom(doc: Y.Doc, change: (text: Y.Text) => void): Uint8Array {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const vector = Y.encodeStateVector(copy);
  change(copy.getText(TEXT_KEY));
  return Y.encodeStateAsUpdate(copy, vector);
}

function insert(index: number, content: string) {
  return (text: Y.Text) => {
    text.insert(index, content);
  };
}

function append(content: string) {
  return (text: Y.Text) => {
    text.insert(text.length, content);
  };
}

function remove(index: number, length: number) {
  return (text: Y.Text) => {
    text.delete(index, length);
  };
}

/** Checks then applies `update` as collab does: beforeSync, then onChange. */
function send(guard: DocumentSizeGuard, doc: Y.Doc, update: Uint8Array): string | null {
  try {
    guard.check('doc', doc, update);
  } catch (error) {
    if (error instanceof InvalidUpdate) return error.detail;
    throw error;
  }
  Y.applyUpdate(doc, update);
  guard.record('doc', update);
  return null;
}

describe('document size guard', () => {
  it('lets a document grow up to the text limit, not beyond', () => {
    const guard = new DocumentSizeGuard({ text: 1_000, state: 10_000 });
    const doc = server('a'.repeat(900));
    expect(send(guard, doc, updateFrom(doc, insert(0, 'b'.repeat(100))))).toBeNull();
    expect(send(guard, doc, updateFrom(doc, insert(0, 'c')))).toBe('too-large');
    expect(doc.getText(TEXT_KEY).length).toBe(1_000);
  });

  it('counts the text in UTF-8 bytes', () => {
    const guard = new DocumentSizeGuard({ text: 1_000, state: 10_000 });
    const doc = server('');
    // 400 characters, 1200 bytes.
    expect(send(guard, doc, updateFrom(doc, insert(0, '€'.repeat(400))))).toBe('too-large');
  });

  it('refuses many small updates that add up past the limit', () => {
    const guard = new DocumentSizeGuard({ text: 1_000, state: 100_000 });
    const doc = server('');
    let refused: string | null = null;
    for (let i = 0; i < 200 && refused === null; i += 1) {
      refused = send(guard, doc, updateFrom(doc, append('abcdefghij')));
    }
    expect(refused).toBe('too-large');
    expect(Buffer.byteLength(doc.getText(TEXT_KEY).toJSON())).toBeLessThanOrEqual(1_000);
  });

  it('accounts for changes made outside the guard', () => {
    const guard = new DocumentSizeGuard({ text: 1_000, state: 10_000 });
    const doc = server('');
    expect(send(guard, doc, updateFrom(doc, insert(0, 'a')))).toBeNull();
    // A server-side replacement, as the API does after an upload.
    const replacement = updateFrom(doc, insert(0, 'r'.repeat(990)));
    Y.applyUpdate(doc, replacement);
    guard.record('doc', replacement);
    expect(send(guard, doc, updateFrom(doc, insert(0, 'b'.repeat(20))))).toBe('too-large');
  });

  it('bounds the state, including data outside the text', () => {
    const guard = new DocumentSizeGuard({ text: 1_000_000, state: 2_000 });
    const doc = server('short');
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const vector = Y.encodeStateVector(copy);
    copy.getMap('extra').set('blob', 'x'.repeat(5_000));
    expect(send(guard, doc, Y.encodeStateAsUpdate(copy, vector))).toBe('too-large');
  });

  it('lets a document above the limit shrink', () => {
    const guard = new DocumentSizeGuard({ text: 1_000, state: 100_000 });
    // Stored before the limit existed, or replaced through the API.
    const doc = server('a'.repeat(2_000));
    expect(send(guard, doc, updateFrom(doc, remove(0, 500)))).toBeNull();
    expect(send(guard, doc, updateFrom(doc, insert(0, 'b')))).toBe('too-large');
  });

  it('refuses a malformed update that may cross the limit', () => {
    const guard = new DocumentSizeGuard({ text: 10, state: 10 });
    const doc = server('');
    expect(send(guard, doc, new Uint8Array(64).fill(0xff))).toBe('malformed');
  });

  it('measures each document anew once forgotten', () => {
    const guard = new DocumentSizeGuard({ text: 1_000, state: 10_000 });
    const doc = server('a'.repeat(990));
    expect(send(guard, doc, updateFrom(doc, remove(0, 500)))).toBeNull();
    guard.forget('doc');
    expect(send(guard, doc, updateFrom(doc, insert(0, 'b'.repeat(400))))).toBeNull();
  });
});
