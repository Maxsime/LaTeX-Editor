import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  foldService,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import type { EditorTheme } from '../stores/editor.js';
import { bibtex } from './bibtex.js';
import { type CompletionSources, latexCompletionSource } from './completion.js';
import { latexFoldRange } from './folding.js';

const latexLanguage = StreamLanguage.define(stex);
const bibtexLanguage = StreamLanguage.define(bibtex);

/** Language of a file, from its extension. */
export function languageFor(name: string): 'latex' | 'bibtex' | 'plain' {
  const lower = name.toLowerCase();
  if (/\.(tex|ltx|sty|cls|dtx|def|bbx|cbx|tikz)$/.test(lower)) return 'latex';
  if (lower.endsWith('.bib')) return 'bibtex';
  return 'plain';
}

const lightHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#7c2d92' },
  { tag: [tags.tagName, tags.function(tags.variableName)], color: '#1e3a8a' },
  { tag: tags.comment, color: '#6b7280', fontStyle: 'italic' },
  { tag: [tags.string, tags.special(tags.string)], color: '#166534' },
  { tag: tags.number, color: '#9a3412' },
  { tag: [tags.bracket, tags.punctuation], color: '#4b5563' },
  { tag: [tags.atom, tags.labelName], color: '#0f766e' },
  { tag: tags.propertyName, color: '#1e40af' },
]);

const darkHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#d8b4fe' },
  { tag: [tags.tagName, tags.function(tags.variableName)], color: '#93c5fd' },
  { tag: tags.comment, color: '#9ca3af', fontStyle: 'italic' },
  { tag: [tags.string, tags.special(tags.string)], color: '#86efac' },
  { tag: tags.number, color: '#fdba74' },
  { tag: [tags.bracket, tags.punctuation], color: '#d1d5db' },
  { tag: [tags.atom, tags.labelName], color: '#5eead4' },
  { tag: tags.propertyName, color: '#bfdbfe' },
]);

function themeExtension(theme: EditorTheme, fontSize: number): Extension {
  const dark = theme === 'dark';
  return [
    EditorView.theme(
      {
        '&': {
          height: '100%',
          fontSize: `${String(fontSize)}px`,
          color: dark ? '#e5e7eb' : '#1f2933',
          backgroundColor: dark ? '#111827' : '#ffffff',
        },
        '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
        '.cm-gutters': {
          backgroundColor: dark ? '#1f2937' : '#f8fafc',
          color: dark ? '#9ca3af' : '#64748b',
          borderRight: `1px solid ${dark ? '#374151' : '#e2e8f0'}`,
        },
        '.cm-activeLine': { backgroundColor: dark ? '#1f293780' : '#f1f5f980' },
        '.cm-activeLineGutter': { backgroundColor: dark ? '#374151' : '#e2e8f0' },
        '&.cm-focused .cm-cursor': { borderLeftColor: dark ? '#f9fafb' : '#111827' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          backgroundColor: dark ? '#1e40af80' : '#bfdbfe',
        },
        '.cm-scroller': { overflow: 'auto' },
      },
      { dark },
    ),
    syntaxHighlighting(dark ? darkHighlight : lightHighlight),
  ];
}

/** Settings that can change while the editor is open. */
export interface LiveSettings {
  theme: EditorTheme;
  fontSize: number;
  lineWrapping: boolean;
  readOnly: boolean;
}

/** Compartments of an editor instance, to reconfigure it in place. */
export class EditorSettings {
  private readonly theme = new Compartment();
  private readonly wrapping = new Compartment();
  private readonly access = new Compartment();

  extensions(settings: LiveSettings): Extension {
    return [
      this.theme.of(themeExtension(settings.theme, settings.fontSize)),
      this.wrapping.of(settings.lineWrapping ? EditorView.lineWrapping : []),
      this.access.of(accessExtension(settings.readOnly)),
    ];
  }

  update(view: EditorView, settings: LiveSettings): void {
    view.dispatch({
      effects: [
        this.theme.reconfigure(themeExtension(settings.theme, settings.fontSize)),
        this.wrapping.reconfigure(settings.lineWrapping ? EditorView.lineWrapping : []),
        this.access.reconfigure(accessExtension(settings.readOnly)),
      ],
    });
  }
}

function accessExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

export interface EditorOptions {
  fileName: string;
  text: Y.Text;
  awareness: Parameters<typeof yCollab>[1];
  settings: EditorSettings;
  live: LiveSettings;
  completion: () => CompletionSources;
  onCursorLine: (line: number) => void;
  onLocalEdit: () => void;
}

/** Builds the full extension set of a text editor bound to a shared Y.Text. */
export function editorExtensions(options: EditorOptions): Extension {
  const language = languageFor(options.fileName);
  // Undo is per user and per document, handled by Yjs rather than CodeMirror's history.
  const undoManager = new Y.UndoManager(options.text);
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    foldGutter(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    language === 'latex' ? latexLanguage : language === 'bibtex' ? bibtexLanguage : [],
    language === 'latex'
      ? [
          foldService.of((state, lineStart) =>
            latexFoldRange(state.doc, state.doc.lineAt(lineStart).number),
          ),
          autocompletion({ override: [latexCompletionSource(options.completion)] }),
        ]
      : [],
    keymap.of([
      // Text is saved continuously; keep the browser from opening its own save dialog.
      { key: 'Mod-s', run: () => true, preventDefault: true },
      { key: 'Mod-/', run: toggleComment },
      ...yUndoManagerKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    yCollab(options.text, options.awareness, { undoManager }),
    options.settings.extensions(options.live),
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) {
        options.onCursorLine(update.state.doc.lineAt(update.state.selection.main.head).number);
      }
      // Remote changes applied by the Yjs binding carry no user event.
      const local = update.transactions.some((transaction) =>
        ['input', 'delete', 'move', 'undo', 'redo'].some((event) => transaction.isUserEvent(event)),
      );
      if (local) {
        options.onLocalEdit();
      }
    }),
  ];
}
