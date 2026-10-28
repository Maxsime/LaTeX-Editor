import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { type VisualOptions, visualDecorations } from './visual-view.js';

const TEXT = '\\section{Intro}\nDu texte \\emph{important}.\n\\section{Fin}';

function spans(state: EditorState, options: VisualOptions): string[] {
  const result: string[] = [];
  visualDecorations(state, options).between(0, state.doc.length, (from, to, value) => {
    // Mark decorations carry their class in a spec CodeMirror types as any.
    const spec = value.spec as { class?: string };
    result.push(`${String(from)}-${String(to)}${spec.class === undefined ? '' : ` ${spec.class}`}`);
  });
  return result;
}

const options: VisualOptions = { macros: () => ({}), protectedSpans: () => [] };

describe('visualDecorations', () => {
  it('hides markup and styles titles, except on the line being edited', () => {
    // The cursor on the last line: its title stays as source.
    const state = EditorState.create({
      doc: TEXT,
      selection: EditorSelection.cursor(TEXT.length),
    });
    expect(spans(state, options)).toEqual([
      '0-9',
      '9-14 cm-visual-h2',
      '14-15',
      '25-31',
      '31-40 cm-visual-italic',
      '40-41',
    ]);
  });

  it('leaves suggestions as written', () => {
    const state = EditorState.create({
      doc: TEXT,
      selection: EditorSelection.cursor(TEXT.length),
    });
    const inSuggestion = spans(state, { ...options, protectedSpans: () => [{ from: 30, to: 35 }] });
    expect(inSuggestion).toEqual(['0-9', '9-14 cm-visual-h2', '14-15']);
  });
});
