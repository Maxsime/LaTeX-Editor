import { describe, expect, it } from 'vitest';
import { applyTheme } from './theme.js';

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
