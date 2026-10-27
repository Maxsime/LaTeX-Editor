import { describe, expect, it } from 'vitest';
import { colorSwatches, cssColor, evaluateColor, parseModel } from './colors.js';

describe('colours', () => {
  it('reads the xcolor models', () => {
    expect(parseModel('HTML', 'FF8000')).toEqual([1, 128 / 255, 0]);
    expect(parseModel('RGB', '0, 0, 255')).toEqual([0, 0, 1]);
    expect(parseModel('rgb', '1,0.5,0')).toEqual([1, 0.5, 0]);
    expect(parseModel('gray', '0.5')).toEqual([0.5, 0.5, 0.5]);
    expect(parseModel('cmyk', '0,1,1,0')).toEqual([1, 0, 0]);
    expect(parseModel('HTML', 'red')).toBeNull();
    expect(parseModel('wave', '500')).toBeNull();
  });

  it('mixes colours as xcolor does', () => {
    const known = new Map();
    expect(cssColor(evaluateColor('red!50', known) ?? [0, 0, 0])).toBe('rgb(255, 128, 128)');
    expect(cssColor(evaluateColor('red!25!blue', known) ?? [0, 0, 0])).toBe('rgb(64, 0, 191)');
    expect(evaluateColor('nosuch', known)).toBeNull();
  });

  it('places swatches after definitions and uses, comments aside', () => {
    const source = [
      '\\definecolor{brand}{HTML}{0F766E}',
      '\\colorlet{soft}{brand!20}',
      '\\textcolor{brand}{a} \\color[rgb]{1,0,0} \\colorbox{unknown}{b}',
      '% \\color{red}',
    ].join('\n');
    const swatches = colorSwatches(source);
    const ends = ['{0F766E}', '{brand!20}', '{brand}', '{1,0,0}'].map(
      (part) => source.lastIndexOf(part) + part.length,
    );
    expect(swatches.map((swatch) => swatch.at)).toEqual(ends);
    expect(cssColor(swatches[0]?.color ?? [0, 0, 0])).toBe('rgb(15, 118, 110)');
  });
});
