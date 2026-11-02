/** Share of the width given to the editor when both the editor and the PDF are shown. */
export const DEFAULT_SPLIT = 0.5;
/** Neither side may shrink below this share, so that both stay usable. */
export const MIN_SPLIT = 0.2;
export const MAX_SPLIT = 0.8;
/** Step of an arrow key on the separator; Shift multiplies it by five. */
export const SPLIT_STEP = 0.02;

/** Keeps a share within the allowed range; anything unreadable falls back to the default. */
export function clampSplit(split: number): number {
  if (!Number.isFinite(split)) return DEFAULT_SPLIT;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, split));
}

/**
 * Share of the editor for a pointer at `x`, given where the editor starts and
 * where the PDF ends. The separator follows the pointer, within the limits.
 */
export function splitAt(x: number, start: number, end: number): number {
  const width = end - start;
  if (width <= 0) return DEFAULT_SPLIT;
  return clampSplit((x - start) / width);
}

/** New share after a key pressed on the separator, or null for a key it ignores. */
export function splitForKey(split: number, key: string, shift: boolean): number | null {
  const step = shift ? SPLIT_STEP * 5 : SPLIT_STEP;
  switch (key) {
    case 'ArrowLeft':
      return clampSplit(split - step);
    case 'ArrowRight':
      return clampSplit(split + step);
    case 'Home':
      return MIN_SPLIT;
    case 'End':
      return MAX_SPLIT;
    case 'Enter':
      return DEFAULT_SPLIT;
    default:
      return null;
  }
}

/**
 * Grid tracks of the two panes, as `fr` values: proportions survive a window
 * resize, and `minmax(0, …)` in the grid lets either side shrink below its content.
 */
export function splitTracks(split: number): { editor: string; pdf: string } {
  const share = clampSplit(split);
  const round = (value: number) => String(Math.round(value * 1000) / 1000);
  return { editor: `${round(share)}fr`, pdf: `${round(1 - share)}fr` };
}
