import { lintGutter } from '@codemirror/lint';
import { Compartment, EditorSelection, type EditorState } from '@codemirror/state';
import { type BibIssue, extractStructure, type LintIssue } from '@galley/latex-index';
import type { Diagnostic } from '@galley/shared';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import i18n from '../i18n/index.js';
import { appendedBlock } from '../lib/writing.js';
import { type Insertion, useEditor, usePreferences } from '../stores/editor.js';
import { useReview } from '../stores/review.js';
import type { CompletionSources } from './completion.js';
import type { ProjectConnection } from './connection.js';
import {
  lintExtension,
  type ProjectLintContext,
  setCompileMarkers,
  toLintDiagnostics,
} from './lint.js';
import { katexMacros } from './math.js';
import { colorPreview, mathPreview } from './preview.js';
import { redrawReview, type ReviewOptions, reviewExtension, suggestingDispatch } from './review.js';
import { EditorSettings, editorExtensions } from './setup.js';
import { type SpellingOptions, spellingExtension } from './spelling.js';

interface CodeEditorProps {
  connection: ProjectConnection;
  fileId: string;
  fileName: string;
  active: boolean;
  /** Role-based restriction; the server enforces it regardless. */
  readOnly: boolean;
  /** Whether edits are recorded as suggestions; the server enforces it for reviewers. */
  suggesting: boolean;
  /** Current user, author of suggestions and comments. */
  userId: string;
  /** Must be stable: a new function rebuilds the editor. */
  completion: () => CompletionSources;
  /** Must be stable, like `completion`. */
  lintContext: () => ProjectLintContext | null;
  /** Diagnostics of the last compilation located in this file, chktex warnings included. */
  diagnostics: readonly Diagnostic[];
  /** The project's macros with a definition, for formula previews. Must be stable. */
  macros: () => Record<string, string>;
  /** Spelling and grammar checking, or null when off or unavailable. */
  spelling: SpellingOptions | null;
  /** Turns a chktex rule off for the project; null for those who cannot. */
  disableChktex: ((rule: number) => void) | null;
}

/** Only documents are checked as they are typed: packages define environments in pieces. */
const LIVE_LINT = /\.(tex|ltx)$/i;

function issueMessage(issue: LintIssue): string {
  return i18n.t(`editor.lint.${issue.code}`, { name: issue.name, expected: issue.expected ?? '' });
}

function bibIssueMessage(issue: BibIssue): string {
  return i18n.t(`editor.bib.${issue.code}`, { name: issue.name ?? '' });
}

function checkOf(fileName: string): 'latex' | 'bibtex' | null {
  if (LIVE_LINT.test(fileName)) return 'latex';
  return fileName.toLowerCase().endsWith('.bib') ? 'bibtex' : null;
}

/**
 * CodeMirror bound to the shared text of one file. The view lives as long as
 * its tab, hidden when inactive, so scroll position and undo history survive
 * tab switches.
 */
export function CodeEditor({
  connection,
  fileId,
  fileName,
  active,
  readOnly,
  suggesting,
  userId,
  completion,
  lintContext,
  diagnostics,
  macros,
  spelling,
  disableChktex,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const settings = useRef(new EditorSettings());
  const spellCompartment = useRef(new Compartment());
  const latex = LIVE_LINT.test(fileName);
  const inserted = useRef<Insertion | null>(null);
  const insertion = useEditor((state) => state.insertion);
  // Status changes re-run the reveal effect; a request must move the cursor only once.
  const revealed = useRef<typeof reveal>(null);
  const { theme, fontSize, lineWrapping } = usePreferences();
  const reveal = useEditor((state) => state.reveal);
  const status = useEditor((state) => state.status[fileId]);
  const reloads = useReview((state) => state.reloads[fileId] ?? 0);
  const openThreads = useReview((state) => state.openThreads);
  // Read by the editor at each edit, so that switching modes needs no rebuild.
  const live = useRef({ suggesting, userId });
  useEffect(() => {
    live.current = { suggesting, userId };
  }, [suggesting, userId]);
  const review = useRef<ReviewOptions | null>(null);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const document = connection.open(fileId);
    const { setCursorLine, noteEdit } = useEditor.getState();
    const preferences = usePreferences.getState();
    const options: ReviewOptions = {
      text: document.text,
      ranges: document.ranges,
      suggesting: () => live.current.suggesting,
      author: () => live.current.userId,
      isOpenThread: (threadId) => useReview.getState().openThreads.has(threadId),
      onComment: (selection) => {
        useReview.getState().setPending({ fileId, ...selection });
      },
      describe: (range) =>
        i18n.t(`review.hover.${range.kind}`, {
          date: 'at' in range ? new Date(range.at).toLocaleString(i18n.language) : '',
        }),
    };
    review.current = options;
    const editor = new EditorView({
      parent,
      dispatchTransactions: suggestingDispatch(options),
      extensions: [
        reviewExtension(options),
        lintGutter(),
        lintExtension({
          check: checkOf(fileName),
          project: lintContext,
          translate: issueMessage,
          translateBib: bibIssueMessage,
          source: i18n.t('editor.lint.sourceEditor'),
        }),
        spellCompartment.current.of([]),
        LIVE_LINT.test(fileName)
          ? [
              mathPreview({
                macros: (state: EditorState) => ({
                  ...macros(),
                  // The edited file's own definitions, before the index catches up.
                  ...katexMacros(extractStructure(state.doc.toString()).commands),
                }),
                errorLabel: i18n.t('editor.math.error'),
              }),
              colorPreview(),
            ]
          : [],
        editorExtensions({
          fileName,
          text: document.text,
          ranges: document.ranges,
          awareness: document.provider.awareness,
          settings: settings.current,
          live: {
            theme: preferences.theme,
            fontSize: preferences.fontSize,
            lineWrapping: preferences.lineWrapping,
            readOnly: true,
          },
          completion,
          onCursorLine: (line) => {
            if (useEditor.getState().activeId === fileId) setCursorLine(line);
          },
          onLocalEdit: noteEdit,
        }),
      ],
    });
    view.current = editor;
    return () => {
      view.current = null;
      review.current = null;
      editor.destroy();
      connection.release(fileId);
    };
    // `reloads` rebinds the editor to the copy loaded after a refused update.
  }, [connection, fileId, fileName, completion, lintContext, macros, reloads]);

  // Reconfigured in place: turning the checker on or off keeps the editor's state.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({
      effects: spellCompartment.current.reconfigure(
        latex && spelling !== null ? spellingExtension(spelling) : [],
      ),
    });
  }, [spelling, latex, reloads]);

  useEffect(() => {
    if (view.current && review.current) redrawReview(view.current, review.current);
  }, [openThreads]);

  // Editing opens once the server has sent the content and granted write access.
  const writable = !readOnly && (status === 'saved' || status === 'saving' || status === 'offline');
  const serverReadOnly = connection.isReadOnly(fileId);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    settings.current.update(editor, {
      theme,
      fontSize,
      lineWrapping,
      readOnly: !writable || serverReadOnly,
    });
  }, [theme, fontSize, lineWrapping, writable, serverReadOnly]);

  // Markers follow the text as it is edited, until the next compilation replaces them.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({
      effects: setCompileMarkers.of(
        toLintDiagnostics(
          editor.state.doc,
          diagnostics,
          i18n.t('editor.lint.sourceCompile'),
          disableChktex === null
            ? undefined
            : { name: i18n.t('editor.chktex.disable'), disable: disableChktex },
        ),
      ),
    });
  }, [diagnostics, status, disableChktex]);

  // Text inserted by a panel or an assistant goes through the editor, as if typed:
  // it can be undone, and becomes a suggestion in suggestion mode.
  useEffect(() => {
    const editor = view.current;
    if (!editor || insertion?.fileId !== fileId || inserted.current === insertion) return;
    if (status === 'connecting' || status === undefined) return;
    inserted.current = insertion;
    if (!writable || serverReadOnly) return;
    const { state } = editor;
    if (insertion.at === 'end') {
      const text = appendedBlock(state.doc.toString(), insertion.text);
      const end = state.doc.length + text.length;
      editor.dispatch({
        changes: { from: state.doc.length, insert: text },
        selection: EditorSelection.cursor(end),
        effects: EditorView.scrollIntoView(end, { y: 'center' }),
        userEvent: 'input',
      });
    } else {
      const { from, to } = state.selection.main;
      editor.dispatch({
        changes: { from, to, insert: insertion.text },
        selection: EditorSelection.cursor(from + insertion.text.length),
        scrollIntoView: true,
        userEvent: 'input',
      });
    }
    editor.focus();
  }, [insertion, fileId, status, writable, serverReadOnly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !active) return;
    editor.requestMeasure();
    editor.focus();
  }, [active]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || reveal?.fileId !== fileId || status === 'connecting' || status === undefined) {
      return;
    }
    if (revealed.current === reveal) return;
    revealed.current = reveal;
    const doc = editor.state.doc;
    const line = doc.line(Math.min(Math.max(reveal.line, 1), doc.lines));
    const from = Math.min(line.from + (reveal.column ?? 0), line.to);
    const to = Math.min(from + (reveal.length ?? 0), doc.length);
    editor.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    editor.focus();
  }, [reveal, fileId, status]);

  return (
    <div
      ref={host}
      data-testid={`editor-${fileId}`}
      data-status={status ?? 'connecting'}
      className={active ? 'h-full min-h-0' : 'hidden'}
    />
  );
}
