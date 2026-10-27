import { type Action, type Diagnostic, forceLinting, linter } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SpellChecker, SpellIssue } from '../lib/spelling.js';

/** Replacements offered per report. */
const MAX_REPLACEMENTS = 3;

export interface SpellingOptions {
  checker: SpellChecker;
  /** Adds a word to the personal dictionary; resolves once the server has it. */
  addWord: (word: string) => Promise<unknown>;
  labels: { addWord: string; ignore: string; source: string };
}

/** Editor markers of the reports, with their correction actions. */
export function spellDiagnostics(
  issues: readonly SpellIssue[],
  options: SpellingOptions,
): Diagnostic[] {
  return issues.map((issue) => {
    const actions: Action[] = issue.match.replacements
      .slice(0, MAX_REPLACEMENTS)
      .map((replacement) => ({
        name: replacement,
        apply: (view, from, to) => {
          view.dispatch({
            changes: { from, to, insert: replacement },
            userEvent: 'input.replace',
          });
        },
      }));
    if (issue.match.kind === 'spelling') {
      actions.push({
        name: options.labels.addWord,
        apply: (view) => {
          void options.addWord(issue.word).then(() => {
            forceLinting(view);
          });
        },
      });
    }
    actions.push({
      name: options.labels.ignore,
      apply: (view) => {
        options.checker.ignore(issue);
        forceLinting(view);
      },
    });
    return {
      from: issue.from,
      to: issue.to,
      // Kept below compilation errors in the gutter; the underline tells the kinds apart.
      severity: issue.match.kind === 'style' ? 'hint' : 'info',
      markClass: `cm-spell-${issue.match.kind}`,
      source: options.labels.source,
      message: issue.match.message,
      actions,
    };
  });
}

const spellTheme = EditorView.baseTheme({
  '.cm-spell-spelling': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy #dc2626',
    textUnderlineOffset: '3px',
  },
  '.cm-spell-grammar': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy #2563eb',
    textUnderlineOffset: '3px',
  },
  '.cm-spell-style': {
    backgroundImage: 'none',
    textDecoration: 'underline dotted #64748b',
    textUnderlineOffset: '3px',
  },
});

/** Spelling and grammar checking of a LaTeX file, one second after typing stops. */
export function spellingExtension(options: SpellingOptions): Extension {
  return [
    spellTheme,
    linter(
      async (view) =>
        spellDiagnostics(await options.checker.check(view.state.doc.toString()), options),
      { delay: 1000 },
    ),
  ];
}
