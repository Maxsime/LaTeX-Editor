import { lintGutter } from '@codemirror/lint';
import { EditorSelection } from '@codemirror/state';
import type { LintIssue } from '@galley/latex-index';
import type { Diagnostic } from '@galley/shared';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import i18n from '../i18n/index.js';
import { useEditor, usePreferences } from '../stores/editor.js';
import { useReview } from '../stores/review.js';
import type { CompletionSources } from './completion.js';
import type { ProjectConnection } from './connection.js';
import {
  lintExtension,
  type ProjectLintContext,
  setCompileMarkers,
  toLintDiagnostics,
} from './lint.js';
import { redrawReview, type ReviewOptions, reviewExtension, suggestingDispatch } from './review.js';
import { EditorSettings, editorExtensions } from './setup.js';

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
  /** Diagnostics of the last compilation located in this file. */
  diagnostics: readonly Diagnostic[];
}

/** Only documents are checked as they are typed: packages define environments in pieces. */
const LIVE_LINT = /\.(tex|ltx)$/i;

function issueMessage(issue: LintIssue): string {
  return i18n.t(`editor.lint.${issue.code}`, { name: issue.name, expected: issue.expected ?? '' });
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
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const settings = useRef(new EditorSettings());
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
          latex: LIVE_LINT.test(fileName),
          project: lintContext,
          translate: issueMessage,
          source: i18n.t('editor.lint.sourceEditor'),
        }),
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
  }, [connection, fileId, fileName, completion, lintContext, reloads]);

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
        toLintDiagnostics(editor.state.doc, diagnostics, i18n.t('editor.lint.sourceCompile')),
      ),
    });
  }, [diagnostics, status]);

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
