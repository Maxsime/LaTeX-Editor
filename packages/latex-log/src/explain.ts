/**
 * Plain-language explanations of common LaTeX errors (SPEC §3.3). Each rule
 * maps a log message to a stable code, translated by the interface, and to the
 * name it concerns when the message gives one. No AI, no network.
 */

/** Codes of the explained messages; the interface holds one text per code. */
export const EXPLANATION_CODES = [
  'undefinedCommand',
  'undefinedEnvironment',
  'missingDollar',
  'fileNotFound',
  'extraBrace',
  'missingBrace',
  'mismatchedEnvironment',
  'missingBeginDocument',
  'undefinedReference',
  'undefinedCitation',
  'duplicateLabel',
  'runawayArgument',
  'paragraphEnded',
  'misplacedAlignment',
  'noLineToEnd',
  'doubleScript',
  'unicodeCharacter',
  'optionClash',
  'missingNumber',
  'illegalUnit',
  'fontNotFound',
] as const;

export type ExplanationCode = (typeof EXPLANATION_CODES)[number];

/** Why a message appeared and what usually fixes it. */
export interface Explanation {
  code: ExplanationCode;
  /** Command, environment, file, key or package the message names; empty when none. */
  name: string;
}

// A quoted name, opened with ` or ' and closed with '.
const QUOTED = "[`']([^']*)'";

const RULES: readonly { pattern: RegExp; code: ExplanationCode }[] = [
  { pattern: /^Undefined control sequence/, code: 'undefinedCommand' },
  { pattern: /^LaTeX Error: Environment (\S+) undefined/, code: 'undefinedEnvironment' },
  { pattern: /^Missing \$ inserted/, code: 'missingDollar' },
  { pattern: /^Display math should end with \$\$/, code: 'missingDollar' },
  { pattern: new RegExp(`^LaTeX Error: File ${QUOTED} not found`), code: 'fileNotFound' },
  { pattern: new RegExp(`^I can't find file ${QUOTED}`), code: 'fileNotFound' },
  { pattern: /^Too many \}'s/, code: 'extraBrace' },
  { pattern: /^Extra \}, or forgotten/, code: 'extraBrace' },
  { pattern: /^Missing \} inserted/, code: 'missingBrace' },
  { pattern: /^Missing \{ inserted/, code: 'missingBrace' },
  {
    pattern: /^LaTeX Error: \\begin\{([^}]*)\} on input line \d+ ended by \\end/,
    code: 'mismatchedEnvironment',
  },
  { pattern: /^LaTeX Error: \\begin\{([^}]*)\} ended by \\end/, code: 'mismatchedEnvironment' },
  { pattern: /^Extra \\endgroup/, code: 'mismatchedEnvironment' },
  { pattern: /^LaTeX Error: Missing \\begin\{document\}/, code: 'missingBeginDocument' },
  { pattern: new RegExp(`^Reference ${QUOTED} on page .* undefined`), code: 'undefinedReference' },
  { pattern: new RegExp(`^Citation ${QUOTED} .*undefined`), code: 'undefinedCitation' },
  { pattern: new RegExp(`^Label ${QUOTED} multiply defined`), code: 'duplicateLabel' },
  { pattern: /^File ended while scanning use of (\\\S+)/, code: 'runawayArgument' },
  { pattern: /^Runaway argument/, code: 'runawayArgument' },
  { pattern: /^Paragraph ended before (\\\S+) was complete/, code: 'paragraphEnded' },
  { pattern: /^Misplaced alignment tab character/, code: 'misplacedAlignment' },
  { pattern: /^LaTeX Error: There's no line here to end/, code: 'noLineToEnd' },
  { pattern: /^Double (?:superscript|subscript)/, code: 'doubleScript' },
  {
    pattern: /^(?:Package inputenc|LaTeX) Error: Unicode character (\S+)/,
    code: 'unicodeCharacter',
  },
  { pattern: /^LaTeX Error: Option clash for package (\S+?)\.?$/, code: 'optionClash' },
  { pattern: /^Missing number, treated as zero/, code: 'missingNumber' },
  { pattern: /^Illegal unit of measure/, code: 'illegalUnit' },
  { pattern: /^Package fontspec Error: The font "([^"]*)" cannot be found/, code: 'fontNotFound' },
  { pattern: /^Font (\\\S+)=\S+ not loadable/, code: 'fontNotFound' },
];

/**
 * Explains a log message, or returns null when it is not a known case.
 *
 * @param message - the entry's message, as `parseTexLog` returns it.
 * @param context - the source excerpt TeX printed, used to name an undefined command.
 */
export function explainMessage(message: string, context = ''): Explanation | null {
  for (const { pattern, code } of RULES) {
    const match = pattern.exec(message);
    if (match === null) continue;
    let name = match[1] ?? '';
    // TeX breaks the context line right after the undefined command.
    if (code === 'undefinedCommand') {
      const firstLine = context.split('\n')[0] ?? '';
      name = /(\\[A-Za-z@]+|\\.)\s*$/.exec(firstLine)?.[1] ?? '';
    }
    return { code, name: name.trim() };
  }
  return null;
}
