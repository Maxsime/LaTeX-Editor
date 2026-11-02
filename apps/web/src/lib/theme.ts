import type { EditorTheme } from '../stores/editor.js';
import { usePreferences } from '../stores/editor.js';

const PREFERENCES_KEY = 'galley.editor.preferences';

/** Puts the page in night mode or back in day mode (the `dark` class of styles.css). */
export function applyTheme(root: HTMLElement, theme: EditorTheme): void {
  root.classList.toggle('dark', theme === 'dark');
}

/**
 * Applies the stored theme now, before the first render (no light flash at
 * load), then follows its changes, including those made in another tab such
 * as the detached PDF window.
 */
export function followTheme(): void {
  const root = document.documentElement;
  applyTheme(root, usePreferences.getState().theme);
  usePreferences.subscribe((state) => {
    applyTheme(root, state.theme);
  });
  window.addEventListener('storage', (event) => {
    if (event.key === PREFERENCES_KEY) void usePreferences.persist.rehydrate();
  });
}
