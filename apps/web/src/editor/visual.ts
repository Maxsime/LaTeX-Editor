/**
 * What the visual editor draws over the LaTeX source (SPEC §3.2): headings,
 * emphasis, list bullets and formulas. The source stays LaTeX; these marks
 * only tell the editor which markup to hide and how to style the rest.
 */

export type VisualStyle = 'italic' | 'bold' | 'underline' | 'mono';

export type VisualMark =
  | {
      kind: 'heading';
      level: number;
      from: number;
      to: number;
      /** The title, between the braces. */
      contentFrom: number;
      contentTo: number;
    }
  | {
      kind: 'style';
      style: VisualStyle;
      from: number;
      to: number;
      contentFrom: number;
      contentTo: number;
    }
  | { kind: 'item'; from: number; to: number }
  | { kind: 'math'; from: number; to: number; tex: string; display: boolean };

const HEADINGS: Readonly<Record<string, number>> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
};

const STYLES: Readonly<Record<string, VisualStyle>> = {
  emph: 'italic',
  textit: 'italic',
  textsl: 'italic',
  textbf: 'bold',
  underline: 'underline',
  texttt: 'mono',
};

const MATH_ENVIRONMENTS = new Set(['equation', 'equation*', 'displaymath', 'math']);

/** Longest formula rendered; longer ones stay as source. */
const MAX_FORMULA = 4000;

/** Offset just after the `}` closing the group opened at `open`, or -1. */
function closingBrace(text: string, open: number, limit: number): number {
  let depth = 0;
  for (let index = open; index < Math.min(text.length, open + limit); index += 1) {
    const char = text[index];
    if (char === '\\') index += 1;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    } else if (char === '\n' && text[index + 1] === '\n') {
      // A blank line ends a paragraph: an argument never spans it.
      return -1;
    }
  }
  return -1;
}

/** End of the formula opened at `index` by `open`, closed by `close`, or -1. */
function closing(text: string, from: number, close: string): number {
  for (let index = from; index < Math.min(text.length, from + MAX_FORMULA); index += 1) {
    const char = text[index];
    if (char === '\\' && !close.startsWith('\\')) {
      index += 1;
      continue;
    }
    if (text.startsWith(close, index)) return index;
    if (char === '\\') index += 1;
  }
  return -1;
}

/**
 * Marks of a LaTeX source, in document order of their start. Comments are
 * skipped. Emphasis and formulas inside a title get marks of their own,
 * nested in the heading's; formulas hide everything they contain.
 */
export function visualMarks(text: string): VisualMark[] {
  const marks: VisualMark[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '%') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '$') {
      const display = text[index + 1] === '$';
      const open = display ? 2 : 1;
      const end = closing(text, index + open, display ? '$$' : '$');
      if (end > index + open) {
        const tex = text.slice(index + open, end);
        if (display || !tex.includes('\n\n')) {
          marks.push({ kind: 'math', from: index, to: end + open, tex: tex.trim(), display });
        }
        index = end + open;
        continue;
      }
      index += open;
      continue;
    }
    if (char !== '\\') {
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (next === '(' || next === '[') {
      const close = next === '(' ? '\\)' : '\\]';
      const end = closing(text, index + 2, close);
      if (end !== -1) {
        marks.push({
          kind: 'math',
          from: index,
          to: end + 2,
          tex: text.slice(index + 2, end).trim(),
          display: next === '[',
        });
        index = end + 2;
        continue;
      }
      index += 2;
      continue;
    }
    const name = /^[A-Za-z]+/.exec(text.slice(index + 1, index + 40))?.[0];
    if (name === undefined) {
      index += 2;
      continue;
    }
    let after = index + 1 + name.length;
    if (name === 'item' && !/[A-Za-z@]/.test(text[after] ?? '')) {
      marks.push({ kind: 'item', from: index, to: after });
      index = after;
      continue;
    }
    if (name === 'begin') {
      const env = /^\{([A-Za-z*]+)\}/.exec(text.slice(after, after + 40))?.[1];
      if (env !== undefined && MATH_ENVIRONMENTS.has(env)) {
        const endTag = `\\end{${env}}`;
        const bodyFrom = after + env.length + 2;
        const end = text.indexOf(endTag, bodyFrom);
        if (end !== -1 && end - bodyFrom <= MAX_FORMULA) {
          const tex = text
            .slice(bodyFrom, end)
            .replace(/\\label\s*\{[^{}]*\}/g, '')
            .replace(/\\(?:nonumber|notag)\b/g, '')
            .trim();
          marks.push({ kind: 'math', from: index, to: end + endTag.length, tex, display: true });
          index = end + endTag.length;
          continue;
        }
      }
    }
    const level = HEADINGS[name];
    const style = STYLES[name];
    if (level !== undefined || style !== undefined) {
      if (level !== undefined && text[after] === '*') after += 1;
      if (text[after] === '{') {
        const end = closingBrace(text, after, 2000);
        if (end !== -1) {
          const range = { from: index, to: end, contentFrom: after + 1, contentTo: end - 1 };
          marks.push(
            level !== undefined
              ? { kind: 'heading', level, ...range }
              : { kind: 'style', style: style ?? 'italic', ...range },
          );
          // Emphasis inside a title is drawn as well: continue inside the braces.
          index = after + 1;
          continue;
        }
      }
    }
    index = after;
  }
  return marks;
}
