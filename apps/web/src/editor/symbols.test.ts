import { describe, expect, it } from 'vitest';
import { PALETTE, searchSymbols } from './symbols.js';

describe('symbol palette', () => {
  it('holds about 250 well-formed symbols', () => {
    expect(PALETTE.length).toBeGreaterThanOrEqual(250);
    for (const symbol of PALETTE) {
      expect(symbol.command).toMatch(/^\\[A-Za-z{}()]+(\{\})*$/);
      expect(symbol.glyph).not.toBe('');
    }
    expect(new Set(PALETTE.map((symbol) => symbol.command)).size).toBe(PALETTE.length);
  });

  it('searches by command, glyph and category', () => {
    expect(searchSymbols('\\alp', null).map((symbol) => symbol.command)).toEqual(['\\alpha']);
    expect(searchSymbols('ℝ', null)).toMatchObject([
      { command: '\\mathbb{R}', package: 'amssymb' },
    ]);
    expect(searchSymbols('', 'greek').every((symbol) => symbol.category === 'greek')).toBe(true);
  });
});
