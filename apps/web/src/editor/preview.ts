import { type EditorState, type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { colorSwatches, cssColor, type Rgb } from './colors.js';
import type * as KatexRender from './katex-render.js';
import { mathAt } from './math.js';

type Renderer = typeof KatexRender;
let renderer: Promise<Renderer> | null = null;

/** KaTeX, loaded once on the first formula shown. */
export function loadRenderer(): Promise<Renderer> {
  renderer ??= import('./katex-render.js');
  return renderer;
}

export interface MathPreviewOptions {
  /** The project's macros, read at each hover so that new definitions apply. */
  macros: (state: EditorState) => Record<string, string>;
  /** Shown above KaTeX's own message when a formula cannot be rendered. */
  errorLabel: string;
}

/** Renders the formula under the pointer in a tooltip. */
export function mathPreview(options: MathPreviewOptions): Extension {
  return [
    hoverTooltip(
      (view, position) => {
        const span = mathAt(view.state.doc.toString(), position);
        if (span === null || span.tex === '') return null;
        const macros = options.macros(view.state);
        return {
          pos: span.from,
          end: span.to,
          above: true,
          create: () => {
            const dom = document.createElement('div');
            dom.className = 'cm-math-preview';
            dom.setAttribute('data-testid', 'math-preview');
            const target = document.createElement('div');
            dom.append(target);
            void loadRenderer().then(
              ({ renderFormula }) => {
                try {
                  renderFormula(span.tex, span.display, macros, target);
                } catch (error) {
                  dom.classList.add('cm-math-error');
                  target.textContent = `${options.errorLabel} ${error instanceof Error ? error.message : ''}`;
                }
              },
              () => {
                target.textContent = options.errorLabel;
              },
            );
            return { dom };
          },
        };
      },
      { hoverTime: 350 },
    ),
    EditorView.baseTheme({
      '.cm-math-preview': { padding: '6px 10px', maxWidth: '40rem', overflowX: 'auto' },
      '.cm-math-error': { color: '#b91c1c', fontSize: '0.85em' },
    }),
  ];
}

class SwatchWidget extends WidgetType {
  constructor(private readonly color: Rgb) {
    super();
  }

  override eq(other: SwatchWidget): boolean {
    return cssColor(other.color) === cssColor(this.color);
  }

  toDOM(): HTMLElement {
    const swatch = document.createElement('span');
    swatch.className = 'cm-color-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    // Through the CSSOM: inline style attributes are refused by the page's policy.
    swatch.style.backgroundColor = cssColor(this.color);
    return swatch;
  }
}

/** Larger files are not decorated: the scan would run on every keystroke. */
const MAX_SWATCH_SOURCE = 500_000;

function swatchDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (state.doc.length > MAX_SWATCH_SOURCE) return builder.finish();
  for (const swatch of colorSwatches(state.doc.toString())) {
    builder.add(
      swatch.at,
      swatch.at,
      Decoration.widget({ widget: new SwatchWidget(swatch.color), side: 1 }),
    );
  }
  return builder.finish();
}

/** Draws a swatch after each colour definition and use. */
export function colorPreview(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = swatchDecorations(view.state);
        }
        update(update: ViewUpdate) {
          if (update.docChanged) this.decorations = swatchDecorations(update.state);
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    EditorView.baseTheme({
      '.cm-color-swatch': {
        display: 'inline-block',
        width: '0.8em',
        height: '0.8em',
        marginLeft: '2px',
        verticalAlign: 'middle',
        border: '1px solid #64748b',
        borderRadius: '2px',
      },
    }),
  ];
}
