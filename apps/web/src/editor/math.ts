/** A formula of the source, as KaTeX should render it. */
export interface MathSpan {
  from: number;
  to: number;
  /** TeX given to the renderer, without delimiters. */
  tex: string;
  display: boolean;
}

/** Display environments, and the KaTeX environment their body goes in. */
const ENVIRONMENTS: Readonly<Record<string, string | null>> = {
  equation: null,
  displaymath: null,
  math: null,
  multline: 'gathered',
  gather: 'gathered',
  align: 'aligned',
  flalign: 'aligned',
  eqnarray: 'aligned',
  alignat: 'alignedat',
};

const LIMIT = 20_000;

/** Removes what KaTeX cannot render and a preview does not need: labels and tags. */
function clean(tex: string): string {
  return tex
    .replace(/\\label\s*\{[^{}]*\}/g, '')
    .replace(/\\(?:nonumber|notag)\b/g, '')
    .trim();
}

function environmentTex(name: string, argument: string, body: string): string {
  const wrapper = ENVIRONMENTS[name] ?? null;
  if (wrapper === null) return clean(body);
  // eqnarray uses three columns `a &=& b`; aligned reads it with an empty middle cell.
  const content = clean(name === 'eqnarray' ? body.replace(/&([^&\\]*)&/g, '$1&') : body);
  return `\\begin{${wrapper}}${argument}${content}\\end{${wrapper}}`;
}

/**
 * Finds the formula that contains `position`: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`
 * or a display environment. Comments and escaped dollars are skipped.
 */
export function mathAt(text: string, position: number): MathSpan | null {
  let index = 0;
  while (index < text.length && index <= position) {
    const char = text[index];
    if (char === '%') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '\\') {
      const next = text[index + 1];
      if (next === '(' || next === '[') {
        const close = next === '(' ? '\\)' : '\\]';
        const end = text.indexOf(close, index + 2);
        if (end === -1 || end - index > LIMIT) return null;
        if (position <= end + 2) {
          return {
            from: index,
            to: end + 2,
            tex: clean(text.slice(index + 2, end)),
            display: next === '[',
          };
        }
        index = end + 2;
        continue;
      }
      const begin = /^\\begin\{([a-zA-Z]+)(\*?)\}(\{\d+\})?/.exec(text.slice(index, index + 40));
      const name = begin?.[1];
      if (begin !== null && name !== undefined && name in ENVIRONMENTS) {
        const closing = `\\end{${name}${begin[2] ?? ''}}`;
        const end = text.indexOf(closing, index);
        if (end === -1 || end - index > LIMIT) return null;
        const to = end + closing.length;
        if (position <= to) {
          const body = text.slice(index + begin[0].length, end);
          return {
            from: index,
            to,
            tex: environmentTex(name, begin[3] ?? '', body),
            display: true,
          };
        }
        index = to;
        continue;
      }
      // An escaped character, \$ included, or a command name.
      index += 2;
      continue;
    }
    if (char === '$') {
      const display = text[index + 1] === '$';
      const open = display ? 2 : 1;
      let end = index + open;
      while (end < text.length) {
        if (text[end] === '\\') {
          end += 2;
          continue;
        }
        if (text[end] === '$') break;
        // Inline formulas do not cross a blank line: TeX would stop there.
        if (!display && text.startsWith('\n\n', end)) return null;
        end += 1;
      }
      if (end >= text.length || end - index > LIMIT) return null;
      const to = end + open;
      if (position <= to) {
        return { from: index, to, tex: clean(text.slice(index + open, end)), display };
      }
      index = to;
      continue;
    }
    index += 1;
  }
  return null;
}

/** A project macro, from the index or the edited file. */
export interface MacroSource {
  name: string;
  definition?: string | undefined;
}

/** KaTeX macros from the project's `\newcommand`s and `\DeclareMathOperator`s. */
export function katexMacros(commands: readonly MacroSource[]): Record<string, string> {
  const macros: Record<string, string> = {};
  for (const command of commands) {
    // `@` names belong to package internals; KaTeX would not parse them anyway.
    if (command.definition === undefined || command.name.includes('@')) continue;
    macros[`\\${command.name}`] = command.definition;
  }
  return macros;
}
