import { type EditorState, type Extension, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { loadRenderer } from './preview.js';
import { type VisualMark, visualMarks } from './visual.js';

export interface VisualOptions {
  /** The project's macros, for formulas. */
  macros: (state: EditorState) => Record<string, string>;
  /** Spans whose markup stays visible: suggestions, so that they remain reviewable. */
  protectedSpans: () => readonly { from: number; to: number }[];
}

/** Larger files stay as source: the scan runs on every cursor move. */
const MAX_VISUAL_SOURCE = 200_000;

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const bullet = document.createElement('span');
    bullet.className = 'cm-visual-bullet';
    bullet.textContent = '•';
    return bullet;
  }
}

class FormulaWidget extends WidgetType {
  constructor(
    private readonly tex: string,
    private readonly display: boolean,
    private readonly macros: Record<string, string>,
  ) {
    super();
  }

  override eq(other: FormulaWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM(): HTMLElement {
    const target = document.createElement('span');
    target.className = this.display ? 'cm-visual-math cm-visual-display' : 'cm-visual-math';
    target.dataset.testid = 'visual-math';
    // The source shows until KaTeX has loaded, and stays if the formula cannot be rendered.
    target.textContent = this.tex;
    void loadRenderer().then(({ renderFormula }) => {
      try {
        renderFormula(this.tex, this.display, this.macros, target);
      } catch {
        target.classList.add('cm-visual-math-error');
      }
    });
    return target;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const hidden = Decoration.replace({});

function overlaps(mark: VisualMark, spans: readonly { from: number; to: number }[]): boolean {
  return spans.some((span) => span.from <= mark.to && span.to >= mark.from);
}

/** Decorations of a state; exported for tests. */
export function visualDecorations(state: EditorState, options: VisualOptions): DecorationSet {
  if (state.doc.length > MAX_VISUAL_SOURCE) return Decoration.none;
  // The lines being edited show their markup, as do suggestions.
  const keep = [
    ...state.selection.ranges.map((range) => ({
      from: state.doc.lineAt(range.from).from,
      to: state.doc.lineAt(range.to).to,
    })),
    ...options.protectedSpans(),
  ];
  const ranges: Range<Decoration>[] = [];
  let macros: Record<string, string> | null = null;
  for (const mark of visualMarks(state.doc.toString())) {
    if (overlaps(mark, keep)) continue;
    if (mark.kind === 'item') {
      ranges.push(bullet.range(mark.from, mark.to));
    } else if (mark.kind === 'math') {
      if (mark.tex === '') continue;
      macros ??= options.macros(state);
      const widget = new FormulaWidget(mark.tex, mark.display, macros);
      ranges.push(Decoration.replace({ widget }).range(mark.from, mark.to));
    } else {
      const style =
        mark.kind === 'heading' ? `cm-visual-h${String(mark.level)}` : `cm-visual-${mark.style}`;
      ranges.push(hidden.range(mark.from, mark.contentFrom));
      if (mark.contentTo > mark.contentFrom) {
        ranges.push(Decoration.mark({ class: style }).range(mark.contentFrom, mark.contentTo));
      }
      ranges.push(hidden.range(mark.contentTo, mark.to));
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * Visual editing of a `.tex` file: hides the markup of titles, emphasis and
 * lists and renders formulas, except on the lines being edited. Text and
 * collaboration are unchanged: it only decorates the LaTeX source.
 */
export function visualEditor(options: VisualOptions): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => visualDecorations(state, options),
    update: (value, transaction) =>
      transaction.docChanged || transaction.selection
        ? visualDecorations(transaction.state, options)
        : value,
    provide: (self) => EditorView.decorations.from(self),
  });
  return [
    field,
    EditorView.baseTheme({
      '.cm-visual-h0, .cm-visual-h1': { fontSize: '1.6em', fontWeight: '700' },
      '.cm-visual-h2': { fontSize: '1.4em', fontWeight: '700' },
      '.cm-visual-h3': { fontSize: '1.2em', fontWeight: '600' },
      '.cm-visual-h4, .cm-visual-h5': { fontWeight: '600' },
      '.cm-visual-italic': { fontStyle: 'italic' },
      '.cm-visual-bold': { fontWeight: '700' },
      '.cm-visual-underline': { textDecoration: 'underline' },
      '.cm-visual-mono': { fontFamily: 'ui-monospace, monospace' },
      '.cm-visual-bullet': { padding: '0 0.4em 0 0.2em' },
      '.cm-visual-math': { fontFamily: 'serif' },
      '.cm-visual-display': { display: 'inline-block', padding: '0.3em 1em' },
      '.cm-visual-math-error': { color: '#b91c1c' },
    }),
  ];
}
