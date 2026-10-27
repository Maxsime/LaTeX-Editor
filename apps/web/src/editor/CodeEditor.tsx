import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { EditorSelection } from '@codemirror/state';
import type { Diagnostic } from '@galley/shared';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { useEditor, usePreferences } from '../stores/editor.js';
import type { CompletionSources } from './completion.js';
import type { ProjectConnection } from './connection.js';
import { toLintDiagnostics } from './lint.js';
import { EditorSettings, editorExtensions } from './setup.js';

interface CodeEditorProps {
  connection: ProjectConnection;
  fileId: string;
  fileName: string;
  active: boolean;
  /** Role-based restriction; the server enforces it regardless. */
  readOnly: boolean;
  /** Must be stable: a new function rebuilds the editor. */
  completion: () => CompletionSources;
  /** Diagnostics of the last compilation located in this file. */
  diagnostics: readonly Diagnostic[];
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
  completion,
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

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const document = connection.open(fileId);
    const { setCursorLine, noteEdit } = useEditor.getState();
    const preferences = usePreferences.getState();
    const editor = new EditorView({
      parent,
      extensions: [
        lintGutter(),
        editorExtensions({
          fileName,
          text: document.text,
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
      editor.destroy();
      connection.release(fileId);
    };
  }, [connection, fileId, fileName, completion]);

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
    editor.dispatch(setDiagnostics(editor.state, toLintDiagnostics(editor.state.doc, diagnostics)));
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
