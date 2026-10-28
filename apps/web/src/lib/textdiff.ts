import { diffLines } from 'diff';

/** A replacement in the original text, as CodeMirror changes describe it. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * Line-level changes that turn `before` into `after`. Applying them instead
 * of replacing the whole document keeps collaborators' cursors, comments and
 * suggestions anchored to the lines that did not change.
 */
export function lineChanges(before: string, after: string): TextChange[] {
  const changes: TextChange[] = [];
  let offset = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) {
      const last = changes.at(-1);
      // A removal followed by an addition at the same place is one replacement.
      if (last?.to === offset && last.insert === '') last.insert = part.value;
      else changes.push({ from: offset, to: offset, insert: part.value });
    } else if (part.removed) {
      changes.push({ from: offset, to: offset + part.value.length, insert: '' });
      offset += part.value.length;
    } else {
      offset += part.value.length;
    }
  }
  return changes;
}
