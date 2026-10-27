import { describe, expect, it } from 'vitest';
import { boxesToShow, toPdfRect, toSynctexPoint } from './synctex.js';

// An A4 page as pdfTeX writes it.
const a4 = [0, 0, 595.276, 841.89] as const;

describe('toSynctexPoint', () => {
  it('measures from the top-left corner of the page', () => {
    expect(toSynctexPoint(a4, 72, 841.89 - 100)).toEqual({ x: 72, y: 100 });
  });

  it('accounts for a view box that does not start at the origin', () => {
    expect(toSynctexPoint([10, 20, 610, 820], 82, 720)).toEqual({ x: 72, y: 100 });
  });

  it('never returns negative coordinates', () => {
    expect(toSynctexPoint(a4, -5, 900)).toEqual({ x: 0, y: 0 });
  });
});

describe('toPdfRect', () => {
  it('turns a box given by its top-left corner into a PDF rectangle', () => {
    const rect = toPdfRect(a4, { page: 1, x: 72, y: 100, width: 300, height: 10 });
    expect(rect[0]).toBe(72);
    expect(rect[1]).toBeCloseTo(841.89 - 110);
    expect(rect[2]).toBe(372);
    expect(rect[3]).toBeCloseTo(841.89 - 100);
  });

  it('is the inverse of toSynctexPoint for the top-left corner', () => {
    const box = { page: 1, x: 50, y: 60, width: 10, height: 5 };
    const [left, , , top] = toPdfRect(a4, box);
    expect(toSynctexPoint(a4, left, top)).toEqual({ x: 50, y: expect.closeTo(60) as number });
  });
});

describe('boxesToShow', () => {
  it('keeps the boxes of the first page', () => {
    const box = (page: number) => ({ page, x: 0, y: 0, width: 1, height: 1 });
    expect(boxesToShow([box(2), box(2), box(3)])).toEqual([box(2), box(2)]);
    expect(boxesToShow([])).toEqual([]);
  });
});
