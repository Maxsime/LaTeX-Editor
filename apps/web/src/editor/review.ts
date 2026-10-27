import {
  ChangeSet,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Transaction,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';
import {
  encodePosition,
  planSuggestion,
  recordSuggestion,
  resolveRanges,
  type ResolvedRange,
  type TextChange,
} from '@galley/review';
import { ySyncAnnotation, ySyncFacet } from 'y-codemirror.next';
import type * as Y from 'yjs';

/**
 * Origin of review operations (accept, reject, comment anchors): neither the
 * editor binding's own origin, so the editor shows them, nor tracked by undo.
 */
export const REVIEW_ORIGIN = Symbol('review');

/** What the editor needs to know about review, read at each use so it can change live. */
export interface ReviewOptions {
  text: Y.Text;
  ranges: Y.Map<unknown>;
  /** Whether local edits are recorded as suggestions. */
  suggesting: () => boolean;
  /** Current user's id, the author of suggestions. */
  author: () => string;
  /** Threads whose anchors are highlighted: open ones. */
  isOpenThread: (threadId: string) => boolean;
  /** Ctrl+Alt+M on a selection. */
  onComment: (selection: { from: number; to: number; quote: string }) => void;
  /** Hover text of a suggestion. */
  describe: (range: ResolvedRange) => string;
}

/** The edits of `transactions` as one list in the coordinates of the text before them. */
export function changesOf(
  start: { length: number },
  transactions: readonly Pick<Transaction, 'changes'>[],
): TextChange[] {
  let composed = ChangeSet.empty(start.length);
  for (const transaction of transactions) composed = composed.compose(transaction.changes);
  const changes: TextChange[] = [];
  composed.iterChanges((from, to, _fromB, _toB, inserted) => {
    changes.push({ from, to, insert: inserted.sliceString(0, inserted.length, '\n') });
  });
  return changes;
}

let suggestionCounter = 0;

function newSuggestionId(): string {
  suggestionCounter += 1;
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${String(suggestionCounter)}`;
}

/**
 * `dispatchTransactions` of an editor in suggestion mode. Local edits are
 * applied in one Yjs transaction with the binding's origin, so that the
 * binding does not echo them, and the suggestion entries that describe them
 * travel in the same update: the server refuses a reviewer's edit without them.
 */
export function suggestingDispatch(options: ReviewOptions) {
  return (transactions: readonly Transaction[], view: EditorView): void => {
    const local =
      options.suggesting() &&
      transactions.some((transaction) => transaction.docChanged) &&
      !transactions.some((transaction) => transaction.annotation(ySyncAnnotation) !== undefined);
    const doc = options.text.doc;
    if (!local || doc === null) {
      view.update(transactions);
      return;
    }
    const conf = view.state.facet(ySyncFacet);
    const changes = changesOf(view.state.doc, transactions);
    doc.transact(() => {
      const author = options.author();
      const plan = planSuggestion(options.text, options.ranges, author, changes);
      // The binding writes the text change into Y here, inside this transaction.
      view.update(transactions);
      recordSuggestion(
        options.text,
        options.ranges,
        { author, now: Date.now(), newId: newSuggestionId },
        plan,
      );
    }, conf);
  };
}

/** Writes the anchor of a new comment thread. */
export function anchorComment(
  text: Y.Text,
  ranges: Y.Map<unknown>,
  threadId: string,
  author: string,
  from: number,
  to: number,
): void {
  text.doc?.transact(() => {
    ranges.set(threadId, {
      kind: 'comment',
      author,
      start: encodePosition(text, from, 0),
      end: encodePosition(text, to, -1),
    });
  }, REVIEW_ORIGIN);
}

/** How a piece of review is drawn, before it becomes a CodeMirror decoration. */
export type ReviewMark =
  | { type: 'insert'; from: number; to: number; id: string; title: string }
  | { type: 'delete'; at: number; text: string; id: string; title: string }
  | { type: 'comment'; from: number; to: number; id: string };

/** Marks for the current state of the document, sorted for a RangeSetBuilder. */
export function reviewMarks(
  resolved: readonly ResolvedRange[],
  length: number,
  isOpenThread: (threadId: string) => boolean,
  describe: (range: ResolvedRange) => string,
): ReviewMark[] {
  const marks: ReviewMark[] = [];
  for (const range of resolved) {
    if (range.kind === 'insert') {
      for (const [from, to] of range.segments) {
        if (to <= length)
          marks.push({ type: 'insert', from, to, id: range.id, title: describe(range) });
      }
    } else if (range.kind === 'delete') {
      if (range.pos <= length) {
        marks.push({
          type: 'delete',
          at: range.pos,
          text: range.text,
          id: range.id,
          title: describe(range),
        });
      }
    } else if (range.to > range.from && range.to <= length && isOpenThread(range.id)) {
      marks.push({ type: 'comment', from: range.from, to: range.to, id: range.id });
    }
  }
  const start = (mark: ReviewMark) => (mark.type === 'delete' ? mark.at : mark.from);
  // Widgets before marks at one position, as RangeSetBuilder wants ranges by start then side.
  const side = (mark: ReviewMark) => (mark.type === 'delete' ? 0 : 1);
  return marks.sort((a, b) => start(a) - start(b) || side(a) - side(b));
}

class DeletionWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly id: string,
    readonly title: string,
  ) {
    super();
  }

  override eq(other: DeletionWidget): boolean {
    return other.text === this.text && other.id === this.id && other.title === this.title;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('del');
    span.className = 'cm-suggest-delete';
    span.textContent = this.text;
    span.title = this.title;
    span.dataset.suggestion = this.id;
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const refresh = StateEffect.define<DecorationSet>();

const reviewTheme = EditorView.baseTheme({
  '.cm-suggest-insert': {
    backgroundColor: '#dcfce7',
    textDecoration: 'underline 2px #16a34a',
  },
  '&dark .cm-suggest-insert': { backgroundColor: '#14532d80' },
  '.cm-suggest-delete': {
    color: '#b91c1c',
    textDecoration: 'line-through',
    backgroundColor: '#fee2e2',
  },
  '&dark .cm-suggest-delete': { color: '#fca5a5', backgroundColor: '#7f1d1d80' },
  '.cm-comment-anchor': { backgroundColor: '#fef9c3', borderBottom: '2px solid #eab308' },
  '&dark .cm-comment-anchor': { backgroundColor: '#713f1280' },
});

function decorationsFor(options: ReviewOptions, length: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const marks = reviewMarks(
    resolveRanges(options.text, options.ranges),
    length,
    options.isOpenThread,
    options.describe,
  );
  for (const mark of marks) {
    if (mark.type === 'delete') {
      builder.add(
        mark.at,
        mark.at,
        Decoration.widget({ widget: new DeletionWidget(mark.text, mark.id, mark.title), side: -1 }),
      );
    } else if (mark.type === 'insert') {
      builder.add(
        mark.from,
        mark.to,
        Decoration.mark({
          class: 'cm-suggest-insert',
          attributes: { title: mark.title, 'data-suggestion': mark.id },
        }),
      );
    } else {
      builder.add(
        mark.from,
        mark.to,
        Decoration.mark({ class: 'cm-comment-anchor', attributes: { 'data-thread': mark.id } }),
      );
    }
  }
  return builder.finish();
}

/**
 * Suggestions and comment anchors drawn in the editor, and Ctrl+Alt+M to
 * comment the selection. Decorations are recomputed after every transaction
 * of the shared document (local, remote, or a change of the entries alone),
 * once the editor has caught up with it.
 */
export function reviewExtension(options: ReviewOptions): Extension {
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      for (const effect of transaction.effects) if (effect.is(refresh)) return effect.value;
      return value.map(transaction.changes);
    },
    provide: (self) => EditorView.decorations.from(self),
  });

  const watcher = ViewPlugin.define((view) => {
    let scheduled = false;
    let destroyed = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      // Never dispatch from inside an editor update or a Yjs transaction.
      queueMicrotask(() => {
        scheduled = false;
        // The binding may not have applied the latest change yet; its own transaction comes next.
        if (destroyed || options.text.length !== view.state.doc.length) return;
        view.dispatch({ effects: refresh.of(decorationsFor(options, view.state.doc.length)) });
      });
    };
    const doc = options.text.doc;
    doc?.on('afterTransaction', schedule);
    schedule();
    return {
      update(update) {
        if (update.docChanged) schedule();
      },
      destroy() {
        destroyed = true;
        doc?.off('afterTransaction', schedule);
      },
    };
  });

  return [
    field,
    watcher,
    reviewTheme,
    keymap.of([
      {
        key: 'Mod-Alt-m',
        preventDefault: true,
        run: (view) => {
          const { from, to } = view.state.selection.main;
          if (from === to) return false;
          options.onComment({ from, to, quote: view.state.sliceDoc(from, to) });
          return true;
        },
      },
    ]),
  ];
}

/** Re-reads which threads are open, after the list of threads changed. */
export function redrawReview(view: EditorView, options: ReviewOptions): void {
  if (options.text.length !== view.state.doc.length) return;
  view.dispatch({ effects: refresh.of(decorationsFor(options, view.state.doc.length)) });
}
