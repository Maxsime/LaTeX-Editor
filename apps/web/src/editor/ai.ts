import { locateHunk } from '@galley/shared';
import { type Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view';

/** A pending hunk of the assistant in the file of the editor. */
export interface Proposal {
  changesetId: string;
  id: string;
  start: number;
  original: string;
  replacement: string;
  before: string;
  after: string;
}

export interface AiEditorOptions {
  /** Ctrl+Alt+K on a selection: asks for the instruction of an inline edit. */
  onInline: (selection: { from: number; to: number; quote: string }) => void;
  onDecide: (proposal: Proposal, decision: 'apply' | 'reject') => void;
  labels: { accept: string; reject: string; proposal: string };
  /** Whether the user may edit, read at each key press. */
  canEdit: () => boolean;
}

/** Replaces the proposals drawn in the editor. */
export const setProposals = StateEffect.define<readonly Proposal[]>();

class ReplacementWidget extends WidgetType {
  constructor(
    readonly proposal: Proposal,
    readonly options: AiEditorOptions,
  ) {
    super();
  }

  override eq(other: ReplacementWidget): boolean {
    return (
      other.proposal.id === this.proposal.id &&
      other.proposal.changesetId === this.proposal.changesetId &&
      other.proposal.replacement === this.proposal.replacement
    );
  }

  toDOM(): HTMLElement {
    const box = document.createElement('span');
    box.className = 'cm-ai-proposal';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', this.options.labels.proposal);
    box.dataset.testid = 'ai-inline-proposal';
    const text = document.createElement('span');
    text.className = 'cm-ai-added';
    text.textContent = this.proposal.replacement;
    box.append(text);
    for (const decision of ['apply', 'reject'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cm-ai-button';
      button.textContent =
        decision === 'apply' ? this.options.labels.accept : this.options.labels.reject;
      button.addEventListener('mousedown', (event) => {
        // Keeps the editor's selection where it was.
        event.preventDefault();
      });
      button.addEventListener('click', () => {
        this.options.onDecide(this.proposal, decision);
      });
      box.append(button);
    }
    return box;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Decorations of the proposals in `text`: the original struck through, the
 * replacement after it with its buttons. A proposal whose place cannot be
 * found any more is not drawn; the panel shows it as a conflict when applied.
 */
export function proposalDecorations(
  text: string,
  proposals: readonly Proposal[],
  options: AiEditorOptions,
): DecorationSet {
  const placed = proposals
    .map((proposal) => ({ proposal, at: locateHunk(text, proposal) }))
    .filter((item): item is { proposal: Proposal; at: number } => item.at !== null)
    .sort((left, right) => left.at - right.at);
  const builder = new RangeSetBuilder<Decoration>();
  let end = 0;
  for (const { proposal, at } of placed) {
    // Overlapping proposals: the first one only, as the server would conflict the others.
    if (at < end) continue;
    const to = at + proposal.original.length;
    if (to > at) builder.add(at, to, Decoration.mark({ class: 'cm-ai-removed' }));
    builder.add(
      to,
      to,
      Decoration.widget({ widget: new ReplacementWidget(proposal, options), side: 1 }),
    );
    end = to;
  }
  return builder.finish();
}

const theme = EditorView.baseTheme({
  '.cm-ai-removed': {
    textDecoration: 'line-through',
    backgroundColor: '#fecaca80',
  },
  '.cm-ai-proposal': {
    backgroundColor: '#bbf7d080',
    borderRadius: '2px',
    padding: '0 2px',
    whiteSpace: 'pre-wrap',
  },
  '.cm-ai-button': {
    marginLeft: '4px',
    fontSize: '0.75em',
    padding: '0 4px',
    border: '1px solid #94a3b8',
    borderRadius: '3px',
    backgroundColor: '#ffffff',
    color: '#0f172a',
    cursor: 'pointer',
  },
});

/** Inline edits (Ctrl+Alt+K) and the drawing of the assistant's proposals in a file. */
export function aiExtension(options: AiEditorOptions): Extension {
  const field = StateField.define<{ proposals: readonly Proposal[]; decorations: DecorationSet }>({
    create: () => ({ proposals: [], decorations: Decoration.none }),
    update(value, transaction) {
      let proposals = value.proposals;
      for (const effect of transaction.effects) {
        if (effect.is(setProposals)) proposals = effect.value;
      }
      if (proposals === value.proposals && !transaction.docChanged) return value;
      // Located again in the new text, as the server will at acceptance.
      return {
        proposals,
        decorations:
          proposals.length === 0
            ? Decoration.none
            : proposalDecorations(transaction.state.doc.toString(), proposals, options),
      };
    },
    provide: (state) => EditorView.decorations.from(state, (value) => value.decorations),
  });
  return [
    field,
    theme,
    keymap.of([
      {
        key: 'Mod-Alt-k',
        preventDefault: true,
        run: (view) => {
          const { from, to } = view.state.selection.main;
          if (from === to || !options.canEdit()) return false;
          options.onInline({ from, to, quote: view.state.sliceDoc(from, to) });
          return true;
        },
      },
    ]),
  ];
}
