import * as Y from 'yjs';

/** Name of the map, beside the text of a file's document, holding suggestions and comment anchors. */
export const RANGES_KEY = 'ranges';

/** Characters `clock` to `clock + length - 1` written by Yjs client `client`. */
export type InsertedRun = [client: number, clock: number, length: number];

/** Characters written by `client` from `clock` on, which spelled `text`. */
export type DeletedRun = [client: number, clock: number, text: string];

/**
 * A suggested insertion: the characters it names are in the document but not
 * accepted yet. Naming Yjs items rather than positions keeps the suggestion
 * exact whatever anyone types around or inside it.
 */
export interface InsertEntry {
  kind: 'insert';
  author: string;
  /** Milliseconds since the epoch. */
  at: number;
  runs: InsertedRun[];
}

/**
 * A suggested deletion: the characters it names are gone from the document
 * but still part of the accepted text. A deleted Yjs item keeps its place in
 * the sequence, so they go back exactly where they were.
 */
export interface DeleteEntry {
  kind: 'delete';
  author: string;
  at: number;
  runs: DeletedRun[];
}

/** Where a comment thread is attached; its key is the thread's id. */
export interface CommentEntry {
  kind: 'comment';
  author: string;
  start: unknown;
  end: unknown;
}

export type RangeEntry = InsertEntry | DeleteEntry | CommentEntry;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isClockPair(value: unknown[]): boolean {
  const [client, clock] = value;
  return Number.isSafeInteger(client) && Number.isSafeInteger(clock) && Number(clock) >= 0;
}

function parseInsertedRuns(value: unknown): InsertedRun[] | null {
  if (!Array.isArray(value)) return null;
  const runs: InsertedRun[] = [];
  for (const run of value) {
    if (!Array.isArray(run) || run.length !== 3 || !isClockPair(run)) return null;
    const [client, clock, length] = run as [number, number, unknown];
    if (!Number.isSafeInteger(length) || Number(length) < 1) return null;
    runs.push([client, clock, Number(length)]);
  }
  return runs;
}

function parseDeletedRuns(value: unknown): DeletedRun[] | null {
  if (!Array.isArray(value)) return null;
  const runs: DeletedRun[] = [];
  for (const run of value) {
    if (!Array.isArray(run) || run.length !== 3 || !isClockPair(run)) return null;
    const [client, clock, text] = run as [number, number, unknown];
    if (typeof text !== 'string' || text === '') return null;
    runs.push([client, clock, text]);
  }
  return runs;
}

/** Reads a stored entry, or `null` when it does not have a known shape. */
export function parseEntry(value: unknown): RangeEntry | null {
  if (!isRecord(value) || typeof value.author !== 'string') return null;
  const { kind, author } = value;
  if ((kind === 'insert' || kind === 'delete') && typeof value.at === 'number') {
    if (kind === 'insert') {
      const runs = parseInsertedRuns(value.runs);
      return runs === null ? null : { kind, author, at: value.at, runs };
    }
    const runs = parseDeletedRuns(value.runs);
    return runs === null ? null : { kind, author, at: value.at, runs };
  }
  if (kind === 'comment' && 'start' in value && 'end' in value) {
    return { kind, author, start: value.start, end: value.end };
  }
  return null;
}

/** Stored form of a position in `text`: `assoc` 0 sticks to the character at `index`, -1 to the one before. */
export function encodePosition(text: Y.Text, index: number, assoc: 0 | -1): unknown {
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index, assoc));
}

/** Current index of a stored position, or `null` when it no longer resolves. */
export function decodePosition(text: Y.Text, stored: unknown): number | null {
  const doc = text.doc;
  if (doc === null || !isRecord(stored)) return null;
  try {
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(stored),
      doc,
    );
    return absolute?.type === text ? absolute.index : null;
  } catch {
    // A position forged or damaged in the document; treat it as lost.
    return null;
  }
}

/** Identity of one character: the Yjs client that wrote it and its clock. */
export interface CharId {
  client: number;
  clock: number;
}

/** Identities of the visible characters `from` to `to - 1`. */
export function liveIds(text: Y.Text, from: number, to: number): CharId[] {
  const ids: CharId[] = [];
  let index = 0;
  for (let item = text._start; item !== null && index < to; item = item.right) {
    if (!item.countable || item.deleted) continue;
    const end = index + item.length;
    for (let at = Math.max(index, from); at < Math.min(end, to); at += 1) {
      ids.push({ client: item.id.client, clock: item.id.clock + at - index });
    }
    index = end;
  }
  return ids;
}

/** A deleted character that some suggested deletions keep in the accepted text. */
export interface DeletedChar extends CharId {
  /** Number of visible characters before it. */
  gap: number;
  char: string;
  /** Ids of the deletion entries naming it. */
  owners: string[];
}

/** Where the entries' characters stand in the text right now. */
export interface Scan {
  /** Visible indices of each insertion's characters, ascending. */
  inserted: Map<string, number[]>;
  /** Characters named by suggested deletions, in sequence order. */
  deleted: DeletedChar[];
}

interface Claim {
  id: string;
  kind: 'insert' | 'delete';
  clock: number;
  length: number;
  text: string;
}

/** Walks the text once, deleted items included, and places every entry's characters. */
export function scan(text: Y.Text, ranges: Y.Map<unknown>): Scan {
  const claims = new Map<number, Claim[]>();
  const inserted = new Map<string, number[]>();
  for (const [id, value] of ranges.entries()) {
    const entry = parseEntry(value);
    if (entry === null || entry.kind === 'comment') continue;
    if (entry.kind === 'insert') inserted.set(id, []);
    for (const [client, clock, extent] of entry.runs) {
      const list = claims.get(client) ?? [];
      list.push(
        typeof extent === 'number'
          ? { id, kind: 'insert', clock, length: extent, text: '' }
          : { id, kind: 'delete', clock, length: extent.length, text: extent },
      );
      claims.set(client, list);
    }
  }
  const deleted: DeletedChar[] = [];
  let live = 0;
  for (let item = text._start; item !== null; item = item.right) {
    // Collected deleted text is no longer countable, yet keeps its ids and length.
    if (!item.deleted && !item.countable) continue;
    const list = claims.get(item.id.client);
    if (list !== undefined) {
      const low = item.id.clock;
      const high = low + item.length;
      const found = new Map<number, DeletedChar>();
      for (const claim of list) {
        const first = Math.max(low, claim.clock);
        const last = Math.min(high, claim.clock + claim.length);
        for (let clock = first; clock < last; clock += 1) {
          if (!item.deleted && claim.kind === 'insert') {
            inserted.get(claim.id)?.push(live + clock - low);
          } else if (item.deleted && claim.kind === 'delete') {
            const char = found.get(clock) ?? {
              client: item.id.client,
              clock,
              gap: live,
              char: claim.text[clock - claim.clock] ?? '',
              owners: [],
            };
            char.owners.push(claim.id);
            found.set(clock, char);
          }
        }
      }
      deleted.push(...[...found.values()].sort((a, b) => a.clock - b.clock));
    }
    if (!item.deleted) live += item.length;
  }
  for (const indices of inserted.values()) indices.sort((a, b) => a - b);
  return { inserted, deleted };
}

export interface ResolvedInsert {
  id: string;
  kind: 'insert';
  author: string;
  at: number;
  from: number;
  to: number;
  /** Contiguous stretches of its characters; others may have typed between them. */
  segments: [from: number, to: number][];
}

export interface ResolvedDelete {
  id: string;
  kind: 'delete';
  author: string;
  at: number;
  /** Visible characters before its first deleted character. */
  pos: number;
  text: string;
}

export interface ResolvedComment {
  id: string;
  kind: 'comment';
  author: string;
  from: number;
  to: number;
}

export type ResolvedRange = ResolvedInsert | ResolvedDelete | ResolvedComment;

function segmentsOf(indices: readonly number[]): [number, number][] {
  const segments: [number, number][] = [];
  for (const index of indices) {
    const last = segments.at(-1);
    if (last?.[1] === index) last[1] = index + 1;
    else segments.push([index, index + 1]);
  }
  return segments;
}

/**
 * Every entry with its current positions, in document order. Suggestions with
 * nothing left to show and comments whose anchors are lost are left out.
 */
export function resolveRanges(
  text: Y.Text,
  ranges: Y.Map<unknown>,
  scanned: Scan = scan(text, ranges),
): ResolvedRange[] {
  const resolved: ResolvedRange[] = [];
  for (const [id, value] of ranges.entries()) {
    const entry = parseEntry(value);
    if (entry === null) continue;
    if (entry.kind === 'insert') {
      const segments = segmentsOf(scanned.inserted.get(id) ?? []);
      const first = segments[0];
      const last = segments.at(-1);
      if (first === undefined || last === undefined) continue;
      const { author, at } = entry;
      resolved.push({ id, kind: 'insert', author, at, from: first[0], to: last[1], segments });
    } else if (entry.kind === 'delete') {
      const chars = scanned.deleted.filter((char) => char.owners.includes(id));
      const first = chars[0];
      if (first === undefined) continue;
      const { author, at } = entry;
      const deletedText = chars.map((char) => char.char).join('');
      resolved.push({ id, kind: 'delete', author, at, pos: first.gap, text: deletedText });
    } else {
      const from = decodePosition(text, entry.start);
      const to = decodePosition(text, entry.end);
      if (from === null || to === null) continue;
      resolved.push({ id, kind: 'comment', author: entry.author, from, to: Math.max(from, to) });
    }
  }
  return resolved.sort(
    (a, b) => start(a) - start(b) || order(a) - order(b) || (a.id < b.id ? -1 : 1),
  );
}

function start(range: ResolvedRange): number {
  return range.kind === 'delete' ? range.pos : range.from;
}

function order(range: ResolvedRange): number {
  return range.kind === 'comment' ? 0 : range.at;
}

/** Suggestions only, in document order. */
export function suggestionsOf(
  text: Y.Text,
  ranges: Y.Map<unknown>,
): (ResolvedInsert | ResolvedDelete)[] {
  return resolveRanges(text, ranges).filter(
    (range): range is ResolvedInsert | ResolvedDelete => range.kind !== 'comment',
  );
}

/**
 * The text as it would be with every suggestion rejected: suggested
 * insertions left out, suggested deletions put back where they were.
 */
export function acceptedText(text: Y.Text, ranges: Y.Map<unknown>): string {
  const proposed = text.toJSON();
  const scanned = scan(text, ranges);
  const inserted = new Uint8Array(proposed.length);
  for (const indices of scanned.inserted.values()) {
    for (const index of indices) inserted[index] = 1;
  }
  let accepted = '';
  let next = 0;
  for (let index = 0; index <= proposed.length; index += 1) {
    for (let char = scanned.deleted[next]; char?.gap === index; char = scanned.deleted[next]) {
      accepted += char.char;
      next += 1;
    }
    if (index < proposed.length && inserted[index] === 0) accepted += proposed[index] ?? '';
  }
  return accepted;
}

/** Shortest list of runs naming `chars`, merging neighbours of one client. */
export function deletedRuns(chars: readonly (CharId & { char: string })[]): DeletedRun[] {
  const runs: DeletedRun[] = [];
  for (const { client, clock, char } of chars) {
    const last = runs.at(-1);
    if (last?.[0] === client && last[1] + last[2].length === clock) last[2] += char;
    else runs.push([client, clock, char]);
  }
  return runs;
}

/** Shortest list of runs naming `ids`, merging neighbours of one client. */
export function insertedRuns(ids: readonly CharId[]): InsertedRun[] {
  const runs: InsertedRun[] = [];
  for (const { client, clock } of ids) {
    const last = runs.at(-1);
    if (last?.[0] === client && last[1] + last[2] === clock) last[2] += 1;
    else runs.push([client, clock, 1]);
  }
  return runs;
}
