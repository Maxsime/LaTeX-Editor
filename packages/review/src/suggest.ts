import type * as Y from 'yjs';
import {
  type DeleteEntry,
  deletedRuns,
  type DeletedRun,
  type InsertEntry,
  insertedRuns,
  liveIds,
  parseEntry,
  scan,
  type Scan,
} from './ranges.js';

/** One replacement in the coordinates of the text before the edit. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Who suggests, when, and how new entries are named. */
export interface Suggester {
  author: string;
  now: number;
  newId: () => string;
}

interface PlannedChange {
  /** Position of the change in the edited text. */
  fromB: number;
  insertLength: number;
  /** Accepted characters the change removes, to keep as a suggested deletion. */
  deleted: DeletedRun[];
  /** Own suggested deletion right beside the change, which these characters extend. */
  mergeInto: string | null;
}

/** What an edit means for the suggestions, worked out before it is applied. */
export interface SuggestionPlan {
  changes: PlannedChange[];
}

function insertedMask(scanned: Scan, length: number): Uint8Array {
  const mask = new Uint8Array(length);
  for (const indices of scanned.inserted.values()) {
    for (const index of indices) mask[index] = 1;
  }
  return mask;
}

function ownEntryOf(ranges: Y.Map<unknown>, id: string, author: string) {
  const entry = parseEntry(ranges.get(id));
  return entry !== null && entry.author === author ? entry : null;
}

/**
 * Splits each change into what it really removes (characters that are
 * themselves suggested insertions) and what it suggests deleting (accepted
 * characters), and finds the suggested deletion of the same author it
 * continues.
 *
 * `changes` must be sorted and must not overlap, as CodeMirror gives them.
 */
export function planSuggestion(
  text: Y.Text,
  ranges: Y.Map<unknown>,
  author: string,
  changes: readonly TextChange[],
): SuggestionPlan {
  const source = text.toJSON();
  const scanned = scan(text, ranges);
  const inserted = insertedMask(scanned, source.length);
  const planned: PlannedChange[] = [];
  let shift = 0;
  for (const change of changes) {
    const ids = liveIds(text, change.from, change.to);
    const accepted = ids
      .map((id, offset) => ({ ...id, index: change.from + offset }))
      .filter(({ index }) => inserted[index] === 0)
      .map((id) => ({ ...id, char: source[id.index] ?? '' }));
    let mergeInto: string | null = null;
    // Repeated Backspace or Delete grows one suggestion instead of making one per key.
    if (change.insert === '' && accepted.length > 0) {
      const beside = scanned.deleted.filter(
        (char) => char.gap === change.from || char.gap === change.to,
      );
      for (const char of beside) {
        const owner = char.owners.find((id) => ownEntryOf(ranges, id, author)?.kind === 'delete');
        if (owner !== undefined) {
          mergeInto = owner;
          break;
        }
      }
    }
    planned.push({
      fromB: change.from + shift,
      insertLength: change.insert.length,
      deleted: deletedRuns(accepted),
      mergeInto,
    });
    shift += change.insert.length - (change.to - change.from);
  }
  return { changes: planned };
}

/**
 * Records a planned edit once its text change is in `text`: inserted
 * characters become (or extend) a suggested insertion of the author, removed
 * accepted characters become (or extend) a suggested deletion. Run it in the
 * same Yjs transaction as the text change, so that both travel as one update.
 */
export function recordSuggestion(
  text: Y.Text,
  ranges: Y.Map<unknown>,
  suggester: Suggester,
  plan: SuggestionPlan,
): void {
  const { author, now } = suggester;
  for (const change of plan.changes) {
    if (change.deleted.length > 0) {
      const merged = change.mergeInto === null ? null : parseEntry(ranges.get(change.mergeInto));
      if (change.mergeInto !== null && merged?.kind === 'delete') {
        const entry: DeleteEntry = {
          ...merged,
          at: now,
          runs: [...merged.runs, ...change.deleted],
        };
        ranges.set(change.mergeInto, entry);
      } else {
        const entry: DeleteEntry = { kind: 'delete', author, at: now, runs: change.deleted };
        ranges.set(suggester.newId(), entry);
      }
    }
    if (change.insertLength === 0) continue;
    const from = change.fromB;
    const to = from + change.insertLength;
    const typed = insertedRuns(liveIds(text, from, to));
    const scanned = scan(text, ranges);
    const neighbour = [...scanned.inserted].find(
      ([id, indices]) =>
        ownEntryOf(ranges, id, author)?.kind === 'insert' &&
        (indices.includes(from - 1) || indices.includes(to)),
    );
    const extended = neighbour === undefined ? null : parseEntry(ranges.get(neighbour[0]));
    if (neighbour !== undefined && extended?.kind === 'insert') {
      const entry: InsertEntry = { ...extended, at: now, runs: [...extended.runs, ...typed] };
      ranges.set(neighbour[0], entry);
    } else {
      const entry: InsertEntry = { kind: 'insert', author, at: now, runs: typed };
      ranges.set(suggester.newId(), entry);
    }
  }
  // An insertion of one's own whose text is all gone has nothing left to decide.
  for (const [id, indices] of scan(text, ranges).inserted) {
    if (indices.length === 0 && ownEntryOf(ranges, id, author) !== null) ranges.delete(id);
  }
}

/**
 * Applies `changes` to `text` as suggestions, in one transaction: the text
 * shows the proposal, `ranges` records what to accept or reject.
 */
export function suggestChanges(
  text: Y.Text,
  ranges: Y.Map<unknown>,
  suggester: Suggester,
  changes: readonly TextChange[],
  origin: unknown = null,
): void {
  const doc = text.doc;
  if (doc === null) throw new Error('the text must belong to a document');
  doc.transact(() => {
    const plan = planSuggestion(text, ranges, suggester.author, changes);
    // From the end, so that earlier positions stay valid.
    for (const change of [...changes].reverse()) {
      if (change.to > change.from) text.delete(change.from, change.to - change.from);
      if (change.insert !== '') text.insert(change.from, change.insert);
    }
    recordSuggestion(text, ranges, suggester, plan);
  }, origin);
}
