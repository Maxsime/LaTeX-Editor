import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  acceptAll,
  acceptedText,
  liveIds,
  rejectAll,
  scan,
  rejectSuggestion,
  RANGES_KEY,
  suggestChanges,
  suggestionsOf,
} from './index.js';

/** An edit drawn without knowing the text: positions are fractions of its length. */
interface DrawnEdit {
  author: string;
  from: number;
  span: number;
  insert: string;
}

const drawnEdit = fc.record({
  author: fc.constantFrom('r', 's'),
  from: fc.double({ min: 0, max: 1, noNaN: true }),
  span: fc.nat({ max: 4 }),
  insert: fc.constantFrom('', '', 'x', 'yz', 'Q W'),
});

const base = fc.string({ unit: fc.constantFrom('a', 'b', 'c', ' ', '\n'), maxLength: 16 });

function documentWith(content: string, client?: number) {
  const doc = new Y.Doc();
  if (client !== undefined) doc.clientID = client;
  const text = doc.getText('content');
  const ranges = doc.getMap<unknown>(RANGES_KEY);
  if (content !== '') text.insert(0, content);
  return { doc, text, ranges };
}

function replicaOf(source: Y.Doc, client: number) {
  const copy = documentWith('', client);
  Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(source));
  return copy;
}

let counter = 0;

function applySuggestion(target: ReturnType<typeof documentWith>, edit: DrawnEdit): void {
  const length = target.text.length;
  const from = Math.min(length, Math.floor(edit.from * (length + 1)));
  const to = Math.min(length, from + edit.span);
  if (from === to && edit.insert === '') return;
  suggestChanges(
    target.text,
    target.ranges,
    { author: edit.author, now: ++counter, newId: () => `id${String(++counter)}` },
    [{ from, to, insert: edit.insert }],
  );
}

function applyDirect(target: ReturnType<typeof documentWith>, edit: DrawnEdit): void {
  const length = target.text.length;
  const from = Math.min(length, Math.floor(edit.from * (length + 1)));
  const to = Math.min(length, from + edit.span);
  target.doc.transact(() => {
    if (to > from) target.text.delete(from, to - from);
    if (edit.insert !== '') target.text.insert(from, edit.insert);
  });
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
}

describe('suggestion properties', () => {
  it('suggesting never changes the accepted text', () => {
    fc.assert(
      fc.property(base, fc.array(drawnEdit, { maxLength: 12 }), (content, edits) => {
        const d = documentWith(content);
        for (const edit of edits) {
          applySuggestion(d, edit);
          expect(acceptedText(d.text, d.ranges)).toBe(content);
        }
      }),
      { numRuns: Number(process.env.RUNS ?? 400) },
    );
  });

  it('rejecting one by one, in any order, gives back the accepted text', () => {
    fc.assert(
      fc.property(
        base,
        fc.array(drawnEdit, { maxLength: 10 }),
        fc.array(fc.nat(), { maxLength: 20 }),
        (content, edits, picks) => {
          const d = documentWith(content);
          for (const edit of edits) applySuggestion(d, edit);
          let remaining = suggestionsOf(d.text, d.ranges);
          for (const pick of picks) {
            if (remaining.length === 0) break;
            const target = remaining[pick % remaining.length];
            if (target === undefined) break;
            rejectSuggestion(d.text, d.ranges, target.id);
            expect(acceptedText(d.text, d.ranges)).toBe(content);
            remaining = suggestionsOf(d.text, d.ranges);
          }
          rejectAll(d.text, d.ranges);
          expect(d.text.toJSON()).toBe(content);
          expect(suggestionsOf(d.text, d.ranges)).toEqual([]);
        },
      ),
      { numRuns: Number(process.env.RUNS ?? 400) },
    );
  });

  it('keeps accept and reject consistent when an editor writes at the same time', () => {
    fc.assert(
      fc.property(
        base,
        fc.array(drawnEdit, { maxLength: 6 }),
        fc.array(drawnEdit, { maxLength: 6 }),
        (content, direct, suggested) => {
          const origin = documentWith(content, 1);
          const editor = replicaOf(origin.doc, 2);
          const reviewer = replicaOf(origin.doc, 3);
          for (const edit of direct) applyDirect(editor, edit);
          for (const edit of suggested) applySuggestion(reviewer, edit);
          const editorOnly = editor.text.toJSON();
          const editorKept = new Set(
            liveIds(editor.text, 0, editor.text.length).map(
              (id) => `${String(id.client)}:${String(id.clock)}`,
            ),
          );
          sync(editor.doc, reviewer.doc);

          // Unless both removed the same character, the accepted text is exactly the editor's.
          const contested = scan(editor.text, editor.ranges).deleted.some(
            (char) => !editorKept.has(`${String(char.client)}:${String(char.clock)}`),
          );
          if (!contested) expect(acceptedText(editor.text, editor.ranges)).toBe(editorOnly);

          // Both replicas see the same proposal and the same accepted text.
          expect(editor.text.toJSON()).toBe(reviewer.text.toJSON());
          const accepted = acceptedText(editor.text, editor.ranges);
          expect(acceptedText(reviewer.text, reviewer.ranges)).toBe(accepted);

          // Rejecting everything lands on the accepted text, on every replica.
          const proposed = editor.text.toJSON();
          rejectAll(reviewer.text, reviewer.ranges);
          expect(reviewer.text.toJSON()).toBe(accepted);
          sync(editor.doc, reviewer.doc);
          expect(editor.text.toJSON()).toBe(accepted);

          // Accepting everything keeps the proposal as it stands.
          const accepting = replicaOf(origin.doc, 4);
          for (const edit of direct) applyDirect(accepting, edit);
          const proposal = replicaOf(origin.doc, 5);
          for (const edit of suggested) applySuggestion(proposal, edit);
          sync(accepting.doc, proposal.doc);
          acceptAll(accepting.ranges);
          expect(accepting.text.toJSON()).toBe(proposed);
          expect(acceptedText(accepting.text, accepting.ranges)).toBe(proposed);
        },
      ),
      { numRuns: Number(process.env.RUNS ?? 300) },
    );
  });

  it('two reviewers suggesting concurrently converge and keep the accepted text', () => {
    fc.assert(
      fc.property(
        base,
        fc.array(drawnEdit, { maxLength: 6 }),
        fc.array(drawnEdit, { maxLength: 6 }),
        (content, first, second) => {
          const origin = documentWith(content, 1);
          const a = replicaOf(origin.doc, 2);
          const b = replicaOf(origin.doc, 3);
          for (const edit of first) applySuggestion(a, { ...edit, author: 'r' });
          for (const edit of second) applySuggestion(b, { ...edit, author: 's' });
          sync(a.doc, b.doc);
          expect(a.text.toJSON()).toBe(b.text.toJSON());
          expect(acceptedText(a.text, a.ranges)).toBe(content);
          expect(acceptedText(b.text, b.ranges)).toBe(content);
          rejectAll(a.text, a.ranges);
          expect(a.text.toJSON()).toBe(content);
        },
      ),
      { numRuns: Number(process.env.RUNS ?? 300) },
    );
  });
});
