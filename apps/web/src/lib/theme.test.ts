import { describe, expect, it } from 'vitest';
import { applyTheme, switchTheme, THEME_FADE_MS } from './theme.js';

function fakeRoot(): HTMLElement {
  const classes = new Set<string>();
  const classList = {
    toggle: (name: string, on: boolean) => {
      if (on) classes.add(name);
      else classes.delete(name);
      return on;
    },
    contains: (name: string) => classes.has(name),
  };
  // Only classList is touched by applyTheme; the tests run without a DOM.
  return { classList } as unknown as HTMLElement;
}

describe('applyTheme', () => {
  it('adds the dark class in night mode and removes it in day mode', () => {
    const root = fakeRoot();
    applyTheme(root, 'dark');
    expect(root.classList.contains('dark')).toBe(true);
    applyTheme(root, 'light');
    expect(root.classList.contains('dark')).toBe(false);
  });
});

describe('switchTheme', () => {
  it('cross-fades for the length of the switch only', () => {
    const root = fakeRoot();
    const scheduled: { done: () => void; ms: number }[] = [];
    switchTheme(root, 'dark', false, (done, ms) => scheduled.push({ done, ms }));
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('theme-transition')).toBe(true);
    expect(scheduled.map((item) => item.ms)).toEqual([THEME_FADE_MS]);
    scheduled[0]?.done();
    expect(root.classList.contains('theme-transition')).toBe(false);
  });

  it('switches at once when the system asks for less motion', () => {
    const root = fakeRoot();
    const scheduled: unknown[] = [];
    switchTheme(root, 'dark', true, () => scheduled.push(null));
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('theme-transition')).toBe(false);
    expect(scheduled).toEqual([]);
  });

  it('does nothing when the theme is already the one asked for', () => {
    const root = fakeRoot();
    const scheduled: unknown[] = [];
    switchTheme(root, 'light', false, () => scheduled.push(null));
    expect(root.classList.contains('theme-transition')).toBe(false);
    expect(scheduled).toEqual([]);
  });
});
