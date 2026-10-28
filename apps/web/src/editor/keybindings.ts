import { Prec, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { yUndoManagerKeymap } from 'y-codemirror.next';

/** Key binding families offered in the editor preferences. */
export type KeyBindings = 'default' | 'vim' | 'emacs';

// Undo is Yjs's, not CodeMirror's history: reuse the commands of its keymap.
function yjsCommand(key: string): (view: EditorView) => boolean {
  const binding = yUndoManagerKeymap.find((entry) => entry.key === key);
  return (view) => binding?.run?.(view) ?? false;
}

let vimReady = false;

/**
 * Extension of a key binding family. Vim and Emacs load on demand, so that
 * people who never turn them on never download them.
 */
export async function loadKeyBindings(mode: KeyBindings): Promise<Extension> {
  if (mode === 'vim') {
    const { vim, Vim } = await import('@replit/codemirror-vim');
    if (!vimReady) {
      vimReady = true;
      const undo = yjsCommand('Mod-z');
      const redo = yjsCommand('Mod-Shift-z');
      // `u` and `Ctrl-R` would otherwise call CodeMirror's history, which this editor lacks.
      Vim.defineAction('undo', (cm: { cm6: EditorView }) => undo(cm.cm6));
      Vim.defineAction('redo', (cm: { cm6: EditorView }) => redo(cm.cm6));
    }
    // Before the other keymaps, which would catch Escape and the letters.
    return Prec.highest(vim({ status: true }));
  }
  if (mode === 'emacs') {
    const { emacs } = await import('@replit/codemirror-emacs');
    return Prec.highest(emacs());
  }
  return [];
}
