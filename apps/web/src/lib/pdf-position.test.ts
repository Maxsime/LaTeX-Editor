import { describe, expect, it } from 'vitest';
import { DEFAULT_SCALE, restorePosition, savePosition } from './pdf-position.js';

describe('reading position', () => {
  it('restores the zoom and the scroll offsets it saved', () => {
    const viewer = { currentScaleValue: '1.5' };
    const container = { scrollTop: 1234, scrollLeft: 56 };
    const saved = savePosition(viewer, container);

    const next = { currentScaleValue: '' };
    const element = { scrollTop: 0, scrollLeft: 0 };
    restorePosition(next, element, saved);
    expect(next.currentScaleValue).toBe('1.5');
    expect(element).toEqual({ scrollTop: 1234, scrollLeft: 56 });
  });

  it('fits the page width when there is nothing to restore', () => {
    const viewer = { currentScaleValue: '' };
    const element = { scrollTop: 0, scrollLeft: 0 };
    restorePosition(viewer, element, null);
    expect(viewer.currentScaleValue).toBe(DEFAULT_SCALE);
    expect(element.scrollTop).toBe(0);
  });
});
