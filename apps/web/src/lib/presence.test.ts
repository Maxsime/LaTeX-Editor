import { presenceUserOf } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { cursorOf, initials, participantsOf } from './presence.js';

const alice = presenceUserOf('00000000-0000-4000-8000-000000000001', 'Alice Martin');
const bruno = presenceUserOf('00000000-0000-4000-8000-000000000002', 'Bruno');
const self = presenceUserOf('00000000-0000-4000-8000-000000000003', 'Moi');

describe('participantsOf', () => {
  it('lists other users once, sorted, with the file they show', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: bruno, fileId: null }],
      [2, { user: alice, fileId: null }],
      [3, { user: alice, fileId: 'f1' }],
      [4, { user: self, fileId: 'f2' }],
    ]);
    expect(participantsOf(states, self.id)).toEqual([
      { user: alice, fileId: 'f1' },
      { user: bruno, fileId: null },
    ]);
  });

  it('ignores states without a valid identity', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, {}],
      [2, { user: { name: 'no id' } }],
      [3, { user: bruno, fileId: 42 }],
    ]);
    expect(participantsOf(states, null)).toEqual([{ user: bruno, fileId: null }]);
  });
});

describe('initials', () => {
  it('takes the first and last word, or the start of a single one', () => {
    expect(initials('Alice Martin')).toBe('AM');
    expect(initials('jean de la Fontaine')).toBe('JF');
    expect(initials('bruno')).toBe('BR');
    expect(initials('  ')).toBe('');
  });
});

describe('cursorOf', () => {
  it("reads the followed person's cursor as an offset of the text", () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'Bonjour le monde');
    const head: unknown = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 8));
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: alice, cursor: { anchor: head, head } }],
    ]);
    expect(cursorOf(states, alice.id, text)).toBe(8);
    // The position follows edits made before it.
    text.insert(0, '« ');
    expect(cursorOf(states, alice.id, text)).toBe(10);
    expect(cursorOf(states, '00000000-0000-4000-8000-000000000009', text)).toBeNull();
    expect(
      cursorOf(new Map([[1, { user: alice, cursor: { head: 'bad' } }]]), alice.id, text),
    ).toBeNull();
  });
});
