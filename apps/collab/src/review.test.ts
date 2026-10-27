import { RANGES_KEY, suggestChanges, type TextChange } from '@galley/review';
import { TEXT_KEY } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { checkReviewerUpdate, InvalidUpdate } from './review.js';

function server(content: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText(TEXT_KEY).insert(0, content);
  return doc;
}

/** What a client holding a copy of `doc` sends after `change`. */
function updateFrom(doc: Y.Doc, change: (copy: Y.Doc) => void): Uint8Array {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const vector = Y.encodeStateVector(copy);
  change(copy);
  return Y.encodeStateAsUpdate(copy, vector);
}

function suggest(author: string, ...changes: TextChange[]) {
  return (copy: Y.Doc) => {
    let n = 0;
    suggestChanges(
      copy.getText(TEXT_KEY),
      copy.getMap(RANGES_KEY),
      { author, now: 1, newId: () => `${author}-${String(++n)}` },
      changes,
    );
  };
}

function refusal(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof InvalidUpdate) return error.detail;
    throw error;
  }
}

describe('reviewer updates', () => {
  it('accepts suggestions of one’s own', () => {
    const doc = server('Le chat dort.');
    const update = updateFrom(doc, suggest('u1', { from: 3, to: 7, insert: 'chien' }));
    expect(
      refusal(() => {
        checkReviewerUpdate(doc, update, 'u1');
      }),
    ).toBeNull();
    // The check works on a copy: the document itself is untouched.
    expect(doc.getText(TEXT_KEY).toJSON()).toBe('Le chat dort.');
  });

  it('refuses a direct edit of the text', () => {
    const doc = server('Le chat dort.');
    const update = updateFrom(doc, (copy) => {
      copy.getText(TEXT_KEY).insert(0, 'X');
    });
    expect(
      refusal(() => {
        checkReviewerUpdate(doc, update, 'u1');
      }),
    ).toBe('accepted-text');
  });

  it('refuses suggestions made in someone else’s name', () => {
    const doc = server('abc');
    const update = updateFrom(doc, suggest('u2', { from: 1, to: 1, insert: 'x' }));
    expect(
      refusal(() => {
        checkReviewerUpdate(doc, update, 'u1');
      }),
    ).toBe('foreign-entry');
  });

  it('refuses touching someone else’s entries, accepting them included', () => {
    const doc = server('abc');
    Y.applyUpdate(doc, updateFrom(doc, suggest('u2', { from: 1, to: 1, insert: 'x' })));
    const update = updateFrom(doc, (copy) => {
      copy.getMap(RANGES_KEY).delete('u2-1');
    });
    // Dropping the entry turns "x" into accepted text, which is caught either way.
    expect(
      refusal(() => {
        checkReviewerUpdate(doc, update, 'u1');
      }),
    ).not.toBeNull();
    const comment = updateFrom(doc, (copy) => {
      copy
        .getMap(RANGES_KEY)
        .set('u2-1', { kind: 'comment', author: 'u1', start: null, end: null });
    });
    expect(
      refusal(() => {
        checkReviewerUpdate(doc, comment, 'u1');
      }),
    ).not.toBeNull();
  });

  it('accepts a comment anchor of one’s own and refuses others’', () => {
    const doc = server('abc');
    const own = updateFrom(doc, (copy) => {
      copy.getMap(RANGES_KEY).set('t1', { kind: 'comment', author: 'u1', start: null, end: null });
    });
    expect(
      refusal(() => {
        checkReviewerUpdate(doc, own, 'u1');
      }),
    ).toBeNull();
    Y.applyUpdate(doc, own);
    const removal = updateFrom(doc, (copy) => {
      copy.getMap(RANGES_KEY).delete('t1');
    });
    expect(
      refusal(() => {
        checkReviewerUpdate(doc, removal, 'u2');
      }),
    ).toBe('foreign-entry');
  });

  it('refuses other roots, text attributes, incomplete and malformed updates', () => {
    const doc = server('abc');
    const root = updateFrom(doc, (copy) => copy.getMap('other').set('k', 1));
    expect(
      refusal(() => {
        checkReviewerUpdate(doc, root, 'u1');
      }),
    ).toBe('root');

    const attribute = updateFrom(doc, (copy) => {
      copy.getText(TEXT_KEY).setAttribute('k', 1);
    });
    expect(
      refusal(() => {
        checkReviewerUpdate(doc, attribute, 'u1');
      }),
    ).toBe('attributes');

    const ahead = new Y.Doc();
    Y.applyUpdate(ahead, Y.encodeStateAsUpdate(doc));
    const base = Y.encodeStateVector(ahead);
    suggest('u1', { from: 0, to: 0, insert: 'x' })(ahead);
    const middle = Y.encodeStateVector(ahead);
    suggest('u1', { from: 1, to: 1, insert: 'y' })(ahead);
    // The second half alone builds on characters the server never saw.
    const gap = Y.encodeStateAsUpdate(ahead, middle);
    expect(Y.encodeStateAsUpdate(ahead, base).length).toBeGreaterThan(gap.length);
    expect(
      refusal(() => {
        checkReviewerUpdate(doc, gap, 'u1');
      }),
    ).toBe('incomplete');

    expect(
      refusal(() => {
        checkReviewerUpdate(doc, new Uint8Array([1, 2, 3, 250]), 'u1');
      }),
    ).toBe('malformed');
  });
});
