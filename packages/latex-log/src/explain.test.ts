import { describe, expect, it } from 'vitest';
import { EXPLANATION_CODES, explainMessage } from './explain.js';

describe('explainMessage', () => {
  it('names the undefined command from the TeX context', () => {
    expect(
      explainMessage(
        'Undefined control sequence.',
        'l.3 Ici, \\commandeinconnue\n                          {} provoque une erreur.',
      ),
    ).toEqual({ code: 'undefinedCommand', name: '\\commandeinconnue' });
    expect(explainMessage('Undefined control sequence.')).toEqual({
      code: 'undefinedCommand',
      name: '',
    });
  });

  it.each([
    ['Missing $ inserted.', 'missingDollar', ''],
    ["LaTeX Error: File `chapitre-absent.tex' not found.", 'fileNotFound', 'chapitre-absent.tex'],
    ["I can't find file `figure'.", 'fileNotFound', 'figure'],
    ["Too many }'s.", 'extraBrace', ''],
    ['Missing } inserted.', 'missingBrace', ''],
    [
      'LaTeX Error: \\begin{itemize} on input line 4 ended by \\end{enumerate}.',
      'mismatchedEnvironment',
      'itemize',
    ],
    ['LaTeX Error: Environment theoreme undefined.', 'undefinedEnvironment', 'theoreme'],
    ['LaTeX Error: Missing \\begin{document}.', 'missingBeginDocument', ''],
    [
      "Reference `sec:absente' on page 1 undefined on input line 3.",
      'undefinedReference',
      'sec:absente',
    ],
    [
      "Citation 'knuth1984' on page 22 undefined on input line 4.",
      'undefinedCitation',
      'knuth1984',
    ],
    ["Label `fig:a' multiply defined.", 'duplicateLabel', 'fig:a'],
    ['File ended while scanning use of \\textbf .', 'runawayArgument', '\\textbf'],
    ['Paragraph ended before \\section was complete.', 'paragraphEnded', '\\section'],
    ['Misplaced alignment tab character &.', 'misplacedAlignment', ''],
    ["LaTeX Error: There's no line here to end.", 'noLineToEnd', ''],
    ['Double superscript.', 'doubleScript', ''],
    ['Package inputenc Error: Unicode character ≠ (U+2260)', 'unicodeCharacter', '≠'],
    ['LaTeX Error: Option clash for package geometry.', 'optionClash', 'geometry'],
    ['Missing number, treated as zero.', 'missingNumber', ''],
    ['Illegal unit of measure (pt inserted).', 'illegalUnit', ''],
    [
      'Package fontspec Error: The font "Garamond Pro" cannot be found.',
      'fontNotFound',
      'Garamond Pro',
    ],
  ])('explains %s', (message, code, name) => {
    expect(explainMessage(message)).toEqual({ code, name });
  });

  it('leaves unknown messages alone', () => {
    expect(explainMessage('There were undefined references.')).toBeNull();
    expect(explainMessage('Overfull \\hbox (1.0pt too wide) in paragraph')).toBeNull();
  });

  it('has a code list without duplicates', () => {
    expect(new Set(EXPLANATION_CODES).size).toBe(EXPLANATION_CODES.length);
  });
});
