/** What {@link realignHunks} needs of a hunk. */
export interface LocatableHunk {
  id: string;
  start: number;
  original: string;
  replacement: string;
  before: string;
  after: string;
}

/** A replacement placed in the current text. */
export interface PlacedEdit {
  id: string;
  from: number;
  to: number;
  insert: string;
}

export interface Realignment {
  /** Edits to apply, from the end of the text backwards so positions stay valid. */
  edits: PlacedEdit[];
  results: Map<string, 'applied' | 'conflict'>;
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    found.push(index);
    index = text.indexOf(needle, index + 1);
  }
  return found;
}

function contextMatches(text: string, at: number, hunk: LocatableHunk): boolean {
  return (
    at + hunk.original.length <= text.length &&
    text.slice(Math.max(0, at - hunk.before.length), at) === hunk.before &&
    text.startsWith(hunk.after, at + hunk.original.length)
  );
}

function nearest(candidates: number[], target: number): number | null {
  let best: number | null = null;
  for (const candidate of candidates) {
    if (best === null || Math.abs(candidate - target) < Math.abs(best - target)) best = candidate;
  }
  return best;
}

/**
 * Finds where a hunk applies in `text`, which may have changed since the hunk
 * was computed (SPEC §6.8): at its position if the original text is still
 * there, else at the occurrence whose surroundings match, else at the only
 * occurrence. Null when it cannot be told apart: a conflict.
 */
export function locateHunk(text: string, hunk: LocatableHunk): number | null {
  if (hunk.original === '') {
    // A pure insertion has only its surroundings to go by.
    if (contextMatches(text, hunk.start, hunk)) return hunk.start;
    const anchor = hunk.before + hunk.after;
    if (anchor === '') return null;
    return nearest(
      occurrences(text, anchor).map((index) => index + hunk.before.length),
      hunk.start,
    );
  }
  if (text.startsWith(hunk.original, hunk.start)) return hunk.start;
  const found = occurrences(text, hunk.original);
  if (found.length === 1) return found[0] ?? null;
  return nearest(
    found.filter((index) => contextMatches(text, index, hunk)),
    hunk.start,
  );
}

/**
 * Places hunks in the current text. A hunk that cannot be found, or that
 * overlaps one placed before it, is a conflict and is left out.
 */
export function realignHunks(text: string, hunks: readonly LocatableHunk[]): Realignment {
  const results = new Map<string, 'applied' | 'conflict'>();
  const placed: PlacedEdit[] = [];
  for (const hunk of hunks) {
    const from = locateHunk(text, hunk);
    if (from === null) {
      results.set(hunk.id, 'conflict');
      continue;
    }
    const edit = { id: hunk.id, from, to: from + hunk.original.length, insert: hunk.replacement };
    const overlaps = placed.some(
      (other) =>
        (edit.from < other.to && other.from < edit.to) ||
        // Two insertions at one point, or an insertion inside a replacement, have no order.
        (edit.from === other.from && (edit.from === edit.to || other.from === other.to)),
    );
    if (overlaps) {
      results.set(hunk.id, 'conflict');
      continue;
    }
    placed.push(edit);
    results.set(hunk.id, 'applied');
  }
  placed.sort((left, right) => right.from - left.from);
  return { edits: placed, results };
}

/** Applies placed edits to a string, as collab does on the shared text. */
export function applyEdits(text: string, edits: readonly PlacedEdit[]): string {
  let result = text;
  for (const edit of edits)
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  return result;
}
