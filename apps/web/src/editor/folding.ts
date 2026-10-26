import type { Text } from '@codemirror/state';

/** Sectioning commands by rank: a section folds until the next one of equal or higher rank. */
const SECTION_RANK: Readonly<Record<string, number>> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

const SECTION =
  /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/;
const BEGIN = /\\begin\s*\{([^}]+)\}/g;
const END = /\\end\s*\{([^}]+)\}/g;
const DOCUMENT_END = /^\s*\\end\s*\{document\}/;

/** Drops a trailing comment so commented-out markers do not count. */
function code(line: string): string {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '\\') index += 1;
    else if (line[index] === '%') return line.slice(0, index);
  }
  return line;
}

/**
 * Fold range starting on line `number` (1-based) of `doc`: an environment
 * opened on that line up to the line of its `\end`, or a sectioning command up
 * to the next heading of the same or higher rank. Returns `null` when the
 * line opens nothing foldable.
 */
export function latexFoldRange(doc: Text, number: number): { from: number; to: number } | null {
  const line = doc.line(number);
  const text = code(line.text);

  const section = SECTION.exec(text);
  if (section?.[1] !== undefined) {
    const rank = SECTION_RANK[section[1]] ?? 0;
    let last = number;
    for (let next = number + 1; next <= doc.lines; next += 1) {
      const candidate = code(doc.line(next).text);
      const heading = SECTION.exec(candidate);
      if (heading?.[1] !== undefined && (SECTION_RANK[heading[1]] ?? 0) <= rank) break;
      if (DOCUMENT_END.test(candidate)) break;
      last = next;
    }
    // Trailing blank lines stay visible between folded sections.
    while (last > number && doc.line(last).text.trim() === '') last -= 1;
    return last > number ? { from: line.to, to: doc.line(last).to } : null;
  }

  // The last environment left open on this line is the one to fold.
  const open: string[] = [];
  for (const match of text.matchAll(BEGIN)) open.push(match[1] ?? '');
  for (const match of text.matchAll(END)) {
    const index = open.lastIndexOf(match[1] ?? '');
    if (index !== -1) open.splice(index, 1);
  }
  const name = open.at(-1);
  if (name === undefined) return null;

  let depth = 1;
  for (let next = number + 1; next <= doc.lines; next += 1) {
    const candidate = code(doc.line(next).text);
    for (const match of candidate.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
      if (match[2] !== name) continue;
      depth += match[1] === 'begin' ? 1 : -1;
      if (depth === 0) {
        // Keep the \end line visible, as editors usually do.
        return next > number + 1 ? { from: line.to, to: doc.line(next - 1).to } : null;
      }
    }
  }
  return null;
}
