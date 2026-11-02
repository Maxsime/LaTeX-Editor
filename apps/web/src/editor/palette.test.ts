import { describe, expect, it } from 'vitest';
import { contrastRatio, editorPalette } from './palette.js';

describe('contrastRatio', () => {
  it('spans 1 to 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });
});

describe.each(['light', 'dark'] as const)('%s editor palette', (theme) => {
  const palette = editorPalette(theme);
  const backgrounds = [palette.background, palette.activeLine];

  it('keeps the plain text readable', () => {
    for (const background of backgrounds) {
      expect(contrastRatio(palette.text, background)).toBeGreaterThanOrEqual(7);
    }
  });

  it.each(Object.entries(palette.tokens))('keeps %s tokens readable (7:1)', (_, colour) => {
    for (const background of backgrounds) {
      expect(contrastRatio(colour, background)).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('light editor palette', () => {
  const palette = editorPalette('light');

  it('writes plain text, braces and punctuation in black', () => {
    expect(palette.text).toBe('#000000');
    expect(palette.tokens.bracket).toBe('#000000');
    expect(palette.tokens.punctuation).toBe('#000000');
  });

  it('uses only dark colours for tokens', () => {
    for (const colour of Object.values(palette.tokens)) {
      // Deep shades that read as dark text, well above the 7:1 floor.
      expect(contrastRatio(colour, '#ffffff')).toBeGreaterThanOrEqual(8);
    }
  });
});
