import type { OutlineEntry } from '@galley/shared';

/**
 * Index of the outline entry containing the cursor: the last heading of the
 * active file at or above the cursor line. `-1` when the file has none.
 */
export function activeOutlineIndex(
  entries: readonly OutlineEntry[],
  fileId: string | null,
  line: number,
): number {
  let found = -1;
  entries.forEach((entry, index) => {
    if (entry.fileId === fileId && entry.line <= line) found = index;
  });
  return found;
}

/** Indentation level of each entry, relative to the shallowest heading of the outline. */
export function relativeDepths(entries: readonly OutlineEntry[]): number[] {
  const minimum = Math.min(...entries.map((entry) => entry.depth));
  return entries.map((entry) => entry.depth - (Number.isFinite(minimum) ? minimum : 0));
}
