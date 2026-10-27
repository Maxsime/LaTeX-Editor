import type * as Y from 'yjs';
import {
  type CharId,
  type DeleteEntry,
  deletedRuns,
  type DeletedChar,
  liveIds,
  parseEntry,
  scan,
} from './ranges.js';

/**
 * Accepts a suggestion: its text becomes accepted as it stands in the
 * document, so only the entry goes.
 */
export function acceptSuggestion(ranges: Y.Map<unknown>, id: string): void {
  const entry = parseEntry(ranges.get(id));
  if (entry !== null && entry.kind !== 'comment') ranges.delete(id);
}

/**
 * Rejects a suggestion: an insertion's characters are removed, a deletion's
 * characters are put back exactly where they were. Runs in a transaction of
 * its own or of the caller.
 */
export function rejectSuggestion(text: Y.Text, ranges: Y.Map<unknown>, id: string): void {
  const doc = text.doc;
  if (doc === null) throw new Error('the text must belong to a document');
  const entry = parseEntry(ranges.get(id));
  if (entry === null || entry.kind === 'comment') return;
  doc.transact(() => {
    const scanned = scan(text, ranges);
    if (entry.kind === 'insert') {
      const indices = scanned.inserted.get(id) ?? [];
      // From the end, so that the remaining indices stay valid.
      for (const index of [...indices].reverse()) text.delete(index, 1);
    } else {
      restoreDeletion(text, ranges, id, scanned.deleted);
    }
    ranges.delete(id);
  });
}

const keyOf = (id: CharId) => `${String(id.client)}:${String(id.clock)}`;

/**
 * Puts a suggested deletion back. Yjs inserts after every deleted item at an
 * index, so restored characters would land after other suggested deletions
 * that were before them. Every suggested deletion at that index is therefore
 * written again, in order, and those still suggested are deleted again and
 * their entries pointed at the new characters.
 */
function restoreDeletion(
  text: Y.Text,
  ranges: Y.Map<unknown>,
  id: string,
  deleted: readonly DeletedChar[],
): void {
  const gaps = [...new Set(deleted.filter((char) => char.owners.includes(id)).map((c) => c.gap))];
  const moved = new Map<string, CharId>();
  // From the end, so that the gaps still to do keep their index.
  for (const gap of gaps.sort((a, b) => b - a)) {
    const chars = deleted.filter((char) => char.gap === gap);
    text.insert(gap, chars.map((char) => char.char).join(''));
    const fresh = liveIds(text, gap, gap + chars.length);
    for (let offset = chars.length - 1; offset >= 0; offset -= 1) {
      const char = chars[offset];
      const copy = fresh[offset];
      if (char === undefined || copy === undefined) continue;
      if (char.owners.some((owner) => owner !== id)) {
        moved.set(keyOf(char), copy);
        text.delete(gap + offset, 1);
      }
    }
  }
  if (moved.size === 0) return;
  for (const [other, value] of ranges.entries()) {
    const entry = parseEntry(value);
    if (other === id || entry?.kind !== 'delete') continue;
    const touched = entry.runs.some(([client, clock, runText]) =>
      Array.from({ length: runText.length }, (_, offset) => offset).some((offset) =>
        moved.has(keyOf({ client, clock: clock + offset })),
      ),
    );
    if (!touched) continue;
    const chars = entry.runs.flatMap(([client, clock, runText]) =>
      // Runs hold UTF-16 units, one per Yjs clock tick, so index them as such.
      Array.from({ length: runText.length }, (_, offset) => {
        const original = { client, clock: clock + offset };
        return { ...(moved.get(keyOf(original)) ?? original), char: runText.charAt(offset) };
      }),
    );
    const updated: DeleteEntry = { ...entry, runs: deletedRuns(chars) };
    ranges.set(other, updated);
  }
}

/** Accepts every suggestion, or those of one author. */
export function acceptAll(ranges: Y.Map<unknown>, author?: string): void {
  const doc = ranges.doc;
  const run = () => {
    for (const [id, value] of [...ranges.entries()]) {
      const entry = parseEntry(value);
      if (entry === null || entry.kind === 'comment') continue;
      if (author === undefined || entry.author === author) ranges.delete(id);
    }
  };
  if (doc === null) run();
  else doc.transact(run);
}

/** Rejects every suggestion, or those of one author. */
export function rejectAll(text: Y.Text, ranges: Y.Map<unknown>, author?: string): void {
  const doc = text.doc;
  if (doc === null) throw new Error('the text must belong to a document');
  doc.transact(() => {
    const mine = [...ranges.entries()].flatMap(([id, value]) => {
      const entry = parseEntry(value);
      return entry !== null && entry.kind !== 'comment' && (author ?? entry.author) === entry.author
        ? [{ id, kind: entry.kind }]
        : [];
    });
    // Insertions first: removing their characters never moves a deleted one.
    for (const { id } of mine.filter((entry) => entry.kind === 'insert')) {
      rejectSuggestion(text, ranges, id);
    }
    for (const { id } of mine.filter((entry) => entry.kind === 'delete')) {
      rejectSuggestion(text, ranges, id);
    }
  });
}
