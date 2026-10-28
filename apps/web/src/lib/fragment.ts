import { MAX_PREVIEW_CODE } from '@galley/shared';
import { visualMarks } from '../editor/visual.js';

/** Ranges of the environments of a text, `document` aside, unbalanced ones left out. */
function environments(text: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  const open: { name: string; from: number }[] = [];
  const tag = /\\(begin|end)\{([^{}]+)\}/g;
  for (let match = tag.exec(text); match !== null; match = tag.exec(text)) {
    const [whole, kind, name = ''] = match;
    if (kind === 'begin') {
      open.push({ name, from: match.index });
      continue;
    }
    const index = open.findLastIndex((entry) => entry.name === name);
    if (index === -1) continue;
    const [start] = open.splice(index);
    if (start !== undefined && name !== 'document') {
      ranges.push({ from: start.from, to: match.index + whole.length });
    }
  }
  return ranges;
}

/**
 * The fragment to preview: the selection when there is one, otherwise the
 * innermost environment or formula around the cursor. Null when the cursor
 * is in plain text, or the fragment is too long to send.
 */
export function fragmentAt(text: string, from: number, to: number): string | null {
  if (to > from) {
    const selected = text.slice(from, to).trim();
    return selected === '' || selected.length > MAX_PREVIEW_CODE ? null : selected;
  }
  const around = [
    ...environments(text),
    ...visualMarks(text).filter((mark) => mark.kind === 'math'),
  ].filter((range) => range.from <= from && from <= range.to);
  const innermost = around.sort((a, b) => a.to - a.from - (b.to - b.from))[0];
  if (innermost === undefined || innermost.to - innermost.from > MAX_PREVIEW_CODE) return null;
  return text.slice(innermost.from, innermost.to);
}
