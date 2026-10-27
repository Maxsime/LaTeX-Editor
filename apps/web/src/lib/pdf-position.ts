/** Where the reader is in the PDF: zoom and scroll offsets of the viewer container. */
export interface ReadingPosition {
  scale: string;
  top: number;
  left: number;
}

/** The parts of pdf.js's viewer the position needs. */
export interface ScalableViewer {
  currentScaleValue: string;
}

/** Zoom of a PDF opened for the first time. */
export const DEFAULT_SCALE = 'page-width';

/** Records the reading position before a new PDF replaces the current one. */
export function savePosition(
  viewer: ScalableViewer,
  container: Pick<HTMLElement, 'scrollTop' | 'scrollLeft'>,
): ReadingPosition {
  return { scale: viewer.currentScaleValue, top: container.scrollTop, left: container.scrollLeft };
}

/**
 * Applies a saved position once the new PDF's pages exist. The zoom comes
 * first, since it sets the height the scroll offset refers to. Pages of two
 * successive compilations have the same size, so the same offset shows the
 * same place, give or take the edit.
 */
export function restorePosition(
  viewer: ScalableViewer,
  container: Pick<HTMLElement, 'scrollTop' | 'scrollLeft'>,
  position: ReadingPosition | null,
): void {
  viewer.currentScaleValue = position?.scale ?? DEFAULT_SCALE;
  if (position) {
    container.scrollTop = position.top;
    container.scrollLeft = position.left;
  }
}
