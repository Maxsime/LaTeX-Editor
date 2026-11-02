import { describe, expect, it } from 'vitest';
import {
  clampSplit,
  DEFAULT_SPLIT,
  MAX_SPLIT,
  MIN_SPLIT,
  splitAt,
  splitForKey,
  splitTracks,
} from './split.js';

describe('clampSplit', () => {
  it('keeps both panes usable', () => {
    expect(clampSplit(0.05)).toBe(MIN_SPLIT);
    expect(clampSplit(0.95)).toBe(MAX_SPLIT);
    expect(clampSplit(0.6)).toBe(0.6);
  });

  it('falls back to an even split for a value it cannot read', () => {
    expect(clampSplit(Number.NaN)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPLIT);
  });
});

describe('splitAt', () => {
  it('follows the pointer between the editor and the end of the PDF', () => {
    expect(splitAt(300, 100, 500)).toBe(0.5);
    expect(splitAt(400, 100, 500)).toBe(0.75);
  });

  it('stops at the limits', () => {
    expect(splitAt(0, 100, 500)).toBe(MIN_SPLIT);
    expect(splitAt(900, 100, 500)).toBe(MAX_SPLIT);
  });

  it('ignores an empty area', () => {
    expect(splitAt(300, 500, 500)).toBe(DEFAULT_SPLIT);
  });
});

describe('splitForKey', () => {
  it('moves by small steps with the arrows, by larger ones with Shift', () => {
    expect(splitForKey(0.5, 'ArrowRight', false)).toBeCloseTo(0.52);
    expect(splitForKey(0.5, 'ArrowLeft', false)).toBeCloseTo(0.48);
    expect(splitForKey(0.5, 'ArrowRight', true)).toBeCloseTo(0.6);
  });

  it('jumps to the limits and back to the middle', () => {
    expect(splitForKey(0.5, 'Home', false)).toBe(MIN_SPLIT);
    expect(splitForKey(0.5, 'End', false)).toBe(MAX_SPLIT);
    expect(splitForKey(0.3, 'Enter', false)).toBe(DEFAULT_SPLIT);
  });

  it('leaves other keys alone', () => {
    expect(splitForKey(0.5, 'a', false)).toBeNull();
  });
});

describe('splitTracks', () => {
  it('gives the two panes complementary fractions', () => {
    expect(splitTracks(0.6)).toEqual({ editor: '0.6fr', pdf: '0.4fr' });
    expect(splitTracks(1 / 3)).toEqual({ editor: '0.333fr', pdf: '0.667fr' });
  });
});
