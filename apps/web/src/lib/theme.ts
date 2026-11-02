import type { EditorTheme } from '../stores/editor.js';
import { usePreferences } from '../stores/editor.js';

const PREFERENCES_KEY = 'galley.editor.preferences';

/** Puts the page in night mode or back in day mode (the `dark` class of styles.css). */
export function applyTheme(root: HTMLElement, theme: EditorTheme): void {
  root.classList.toggle('dark', theme === 'dark');
}

/** Length of the day/night cross-fade, a little over the CSS transition. */
export const THEME_FADE_MS = 260;

/**
 * Switches the theme with a short cross-fade of every colour (the
 * `theme-transition` class of styles.css), unless the person asked their
 * system for less motion. The class is removed once the fade is over, so that
 * it never slows down ordinary hovers.
 */
export function switchTheme(
  root: HTMLElement,
  theme: EditorTheme,
  reducedMotion: boolean,
  schedule: (done: () => void, ms: number) => unknown = setTimeout,
): void {
  if (root.classList.contains('dark') === (theme === 'dark')) return;
  if (!reducedMotion) {
    root.classList.toggle('theme-transition', true);
    schedule(() => {
      root.classList.toggle('theme-transition', false);
    }, THEME_FADE_MS);
  }
  applyTheme(root, theme);
}

/**
 * Applies the stored theme now, before the first render (no light flash at
 * load), then follows its changes with a cross-fade, including those made in another tab such
 * as the detached PDF window.
 */
export function followTheme(): void {
  const root = document.documentElement;
  applyTheme(root, usePreferences.getState().theme);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  usePreferences.subscribe((state) => {
    switchTheme(root, state.theme, reducedMotion.matches);
  });
  window.addEventListener('storage', (event) => {
    if (event.key === PREFERENCES_KEY) void usePreferences.persist.rehydrate();
  });
}
