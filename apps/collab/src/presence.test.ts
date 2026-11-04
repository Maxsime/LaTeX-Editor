import { describe, expect, it } from 'vitest';
import { filterPresence, MAX_PRESENCE_CLIENTS, MAX_PRESENCE_STATE_BYTES } from './presence.js';

function states(...entries: [number, Record<string, unknown>][]) {
  return new Map(entries);
}

describe('presence filter', () => {
  it('keeps the entry a connection announces for itself', () => {
    const owners = new Map<number, string>();
    const sent = states([1, { cursor: { anchor: 3 } }]);
    filterPresence(owners, 'alice', () => true, sent, new Set());
    expect([...sent.keys()]).toEqual([1]);
    expect(owners.get(1)).toBe('alice');
  });

  it('drops entries that move or remove the cursor of another connection', () => {
    const owners = new Map([[1, 'alice']]);
    const sent = states([1, { cursor: { anchor: 0 } }], [2, { cursor: null }]);
    const removed = new Set([1]);
    filterPresence(owners, 'mallory', () => true, sent, removed);
    expect([...sent.keys()]).toEqual([2]);
    expect(removed.size).toBe(0);
  });

  it('releases the ids of connections that have gone', () => {
    const owners = new Map([[1, 'old socket']]);
    const sent = states([1, { cursor: null }]);
    filterPresence(owners, 'new socket', (owner) => owner !== 'old socket', sent, new Set());
    expect([...sent.keys()]).toEqual([1]);
    expect(owners.get(1)).toBe('new socket');
  });

  it('drops oversized states', () => {
    const owners = new Map<number, string>();
    const sent = states([1, { junk: 'x'.repeat(MAX_PRESENCE_STATE_BYTES) }]);
    filterPresence(owners, 'mallory', () => true, sent, new Set());
    expect(sent.size).toBe(0);
  });

  it('caps the entries one connection may hold', () => {
    const owners = new Map<number, string>();
    const sent = states(
      ...Array.from({ length: 50 }, (_, i): [number, Record<string, unknown>] => [i, {}]),
    );
    filterPresence(owners, 'mallory', () => true, sent, new Set());
    expect(sent.size).toBe(MAX_PRESENCE_CLIENTS);
    filterPresence(owners, 'mallory', () => true, states([99, {}]), new Set());
    expect(owners.size).toBe(MAX_PRESENCE_CLIENTS);
  });
});
