import type * as Y from 'yjs';

/**
 * Replaces the content of a shared text with `next`, touching only the span
 * between the common prefix and suffix. Collaborators' cursors and pending
 * edits outside that span survive, which a delete-all-then-insert would break.
 */
export function replaceText(text: Y.Text, next: string): void {
  const current = text.toJSON();
  if (current === next) return;
  const limit = Math.min(current.length, next.length);
  let start = 0;
  while (start < limit && current.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let end = 0;
  while (
    end < limit - start &&
    current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  ) {
    end += 1;
  }
  // Never split a surrogate pair: Yjs counts UTF-16 units and would store half a character.
  if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start -= 1;
  if (end > 0 && isLowSurrogate(current.charCodeAt(current.length - end))) end -= 1;

  const removed = current.length - start - end;
  const inserted = next.slice(start, next.length - end);
  if (removed > 0) text.delete(start, removed);
  if (inserted.length > 0) text.insert(start, inserted);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
