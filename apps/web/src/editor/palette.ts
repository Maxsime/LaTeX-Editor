import type { EditorTheme } from '../stores/editor.js';

/**
 * Highlighting classes the LaTeX and BibTeX modes produce. Each one gets a colour in
 * both themes, so that no token falls back to a colour picked for the other theme.
 */
export type TokenClass =
  | 'command'
  | 'environment'
  | 'mathDelimiter'
  | 'bracket'
  | 'punctuation'
  | 'comment'
  | 'string'
  | 'number'
  | 'property'
  | 'builtin'
  | 'invalid';

/** Colours of one editor theme. */
export interface EditorPalette {
  text: string;
  background: string;
  /** Opaque; the editor draws it at half opacity, above the selection. */
  activeLine: string;
  selection: string;
  gutterText: string;
  gutterBackground: string;
  gutterBorder: string;
  activeLineGutter: string;
  cursor: string;
  tokens: Record<TokenClass, string>;
}

/**
 * Light theme: every token is black or a deep shade that reads as dark text
 * (contrast of at least 7:1, WCAG AAA, checked by palette.test.ts). Symbols,
 * braces and punctuation are plain black: only commands and a few classes keep
 * a hue, to tell markup from text.
 */
const light: EditorPalette = {
  text: '#000000',
  background: '#ffffff',
  activeLine: '#f1f5f9',
  selection: '#bfdbfe',
  gutterText: '#475569',
  gutterBackground: '#f8fafc',
  gutterBorder: '#e2e8f0',
  activeLineGutter: '#e2e8f0',
  cursor: '#000000',
  tokens: {
    command: '#1e3a8a',
    environment: '#134e4a',
    mathDelimiter: '#6b21a8',
    bracket: '#000000',
    punctuation: '#000000',
    comment: '#404853',
    string: '#14532d',
    number: '#7c2d12',
    property: '#1e3a8a',
    builtin: '#1e3a8a',
    invalid: '#991b1b',
  },
};

/** Night theme: light tokens on a dark background, same contrast floor. */
const dark: EditorPalette = {
  text: '#e5e7eb',
  background: '#111827',
  activeLine: '#1f2937',
  selection: '#1e40af80',
  gutterText: '#9ca3af',
  gutterBackground: '#0f141c',
  gutterBorder: '#374151',
  activeLineGutter: '#374151',
  cursor: '#f9fafb',
  tokens: {
    command: '#93c5fd',
    environment: '#5eead4',
    mathDelimiter: '#d8b4fe',
    bracket: '#e5e7eb',
    punctuation: '#e5e7eb',
    comment: '#b4bcc8',
    string: '#86efac',
    number: '#fdba74',
    property: '#bfdbfe',
    builtin: '#93c5fd',
    invalid: '#fca5a5',
  },
};

/** Colours of the editor for a theme. */
export function editorPalette(theme: EditorTheme): EditorPalette {
  return theme === 'dark' ? dark : light;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [match[1], match[2], match[3]].map((part) =>
    channel(parseInt(part ?? '0', 16)),
  );
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG contrast ratio between two `#rrggbb` colours, from 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
