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
import { styleNonce } from '../lib/csp.js';
import type { EditorTheme } from '../stores/editor.js';
import { bibtex } from './bibtex.js';
import { type CompletionSources, latexCompletionSource } from './completion.js';
import { latexFoldRange } from './folding.js';
import { editorPalette } from './palette.js';

const latexLanguage = StreamLanguage.define(stex);
const bibtexLanguage = StreamLanguage.define(bibtex);

/** Language of a file, from its extension. */
export function languageFor(name: string): 'latex' | 'bibtex' | 'plain' {
  const lower = name.toLowerCase();
  if (/\.(tex|ltx|sty|cls|dtx|def|bbx|cbx|tikz)$/.test(lower)) return 'latex';
  if (lower.endsWith('.bib')) return 'bibtex';
  return 'plain';
}

function highlightFor(theme: EditorTheme): HighlightStyle {
  const { tokens } = editorPalette(theme);
  return HighlightStyle.define([
    { tag: [tags.tagName, tags.function(tags.variableName)], color: tokens.command },
    { tag: [tags.atom, tags.labelName], color: tokens.environment },
    { tag: tags.keyword, color: tokens.mathDelimiter },
    { tag: tags.bracket, color: tokens.bracket },
    { tag: [tags.punctuation, tags.operator], color: tokens.punctuation },
    { tag: tags.comment, color: tokens.comment, fontStyle: 'italic' },
    { tag: [tags.string, tags.special(tags.string)], color: tokens.string },
    { tag: tags.number, color: tokens.number },
    { tag: tags.propertyName, color: tokens.property },
    { tag: tags.standard(tags.variableName), color: tokens.builtin },
    { tag: tags.invalid, color: tokens.invalid },
  ]);
}

// Built once: CodeMirror compares highlight styles by identity when reconfiguring.
const highlights = { light: highlightFor('light'), dark: highlightFor('dark') };

function themeExtension(theme: EditorTheme, fontSize: number): Extension {
  const dark = theme === 'dark';
  const palette = editorPalette(theme);
  return [
    EditorView.theme(
      {
        '&': {
          height: '100%',
          fontSize: `${String(fontSize)}px`,
          color: palette.text,
          backgroundColor: palette.background,
        },
        '.cm-content': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          caretColor: palette.cursor,
        },
        '.cm-gutters': {
          backgroundColor: palette.gutterBackground,
          color: palette.gutterText,
          borderRight: `1px solid ${palette.gutterBorder}`,
        },
        // Translucent: the active line is drawn above the selection layer.
        '.cm-activeLine': { backgroundColor: `${palette.activeLine}80` },
        '.cm-activeLineGutter': { backgroundColor: palette.activeLineGutter },
        '&.cm-focused .cm-cursor': { borderLeftColor: palette.cursor },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          backgroundColor: palette.selection,
        },
        '.cm-specialChar': { color: palette.tokens.invalid },
        '.cm-scroller': { overflow: 'auto' },
      },
      { dark },
    ),
    syntaxHighlighting(highlights[theme]),
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
  private readonly keys = new Compartment();
  /** Kept so that an editor rebuilt for the same file keeps the person's key bindings. */
  private keyBindings: Extension = [];

  extensions(settings: LiveSettings): Extension {
    return [
      this.keys.of(this.keyBindings),
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

  /** Swaps the key binding family (Vim, Emacs), once its module has loaded. */
  setKeyBindings(view: EditorView, extension: Extension): void {
    this.keyBindings = extension;
    view.dispatch({ effects: this.keys.reconfigure(extension) });
  }
}

function accessExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

export interface EditorOptions {
  fileName: string;
  text: Y.Text;
  /** Suggestions and comment anchors: undo takes back a suggestion with its entry. */
  ranges: Y.Map<unknown>;
  awareness: Parameters<typeof yCollab>[1];
  settings: EditorSettings;
  live: LiveSettings;
  completion: () => CompletionSources;
  /** The cursor's line and the main selection, after each move or edit. */
  onCursor: (line: number, selection: { head: number; from: number; to: number }) => void;
  onLocalEdit: () => void;
}

/** Builds the full extension set of a text editor bound to a shared Y.Text. */
export function editorExtensions(options: EditorOptions): Extension {
  const language = languageFor(options.fileName);
  // Undo is per user and per document, handled by Yjs rather than CodeMirror's history.
  const undoManager = new Y.UndoManager([options.text, options.ranges]);
  const nonce = styleNonce();
  return [
    nonce === null ? [] : EditorView.cspNonce.of(nonce),
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
        const { head, from, to } = update.state.selection.main;
        options.onCursor(update.state.doc.lineAt(head).number, { head, from, to });
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
