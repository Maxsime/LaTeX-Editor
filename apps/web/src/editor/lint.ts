import { type Diagnostic as LintDiagnostic, linter } from '@codemirror/lint';
import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state';
import {
  type BibIssue,
  checkBibtex,
  extractStructure,
  type LintIssue,
  lintDocument,
} from '@galley/latex-index';
import type { Diagnostic } from '@galley/shared';

const SEVERITY: Record<Diagnostic['level'], LintDiagnostic['severity']> = {
  error: 'error',
  warning: 'warning',
  badbox: 'info',
};

/** Turns off a chktex warning for the project, from its marker. */
export interface ChktexAction {
  name: string;
  disable: (rule: number) => void;
}

/**
 * Turns compilation diagnostics of one file into editor markers spanning their
 * line. Lines past the end, from a compilation of an older version of the
 * file, are clamped to the last line rather than dropped. chktex warnings are
 * shown as information, with an action turning their rule off.
 */
export function toLintDiagnostics(
  doc: Text,
  diagnostics: readonly Diagnostic[],
  source?: string,
  chktex?: ChktexAction,
): LintDiagnostic[] {
  const markers: LintDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.line === null) continue;
    const line = doc.line(Math.min(Math.max(diagnostic.line, 1), doc.lines));
    if (diagnostic.source === 'chktex') {
      const rule = Number(diagnostic.context);
      markers.push({
        from: line.from,
        to: line.to,
        severity: 'info',
        source: `chktex ${diagnostic.context}`,
        message: diagnostic.message,
        ...(chktex === undefined || !Number.isInteger(rule)
          ? {}
          : {
              actions: [
                {
                  name: chktex.name,
                  apply: () => {
                    chktex.disable(rule);
                  },
                },
              ],
            }),
      });
      continue;
    }
    markers.push({
      from: line.from,
      to: line.to,
      severity: SEVERITY[diagnostic.level],
      source: source ?? diagnostic.source,
      message: diagnostic.message,
    });
  }
  return markers;
}

/** What the project's other files contribute to the checks of the edited one. */
export interface ProjectLintContext {
  /** Definitions of each label in the other files. */
  labelCounts: ReadonlyMap<string, number>;
  /** Citation keys of the bibliographies and of the other files' `\bibitem`s. */
  citationKeys: ReadonlySet<string>;
  /** Keys of the entries of the other `.bib` files, to report keys defined twice. */
  otherBibKeys: ReadonlySet<string>;
}

/** Message of a `.bib` issue, in the interface language. */
export type BibIssueTranslator = (issue: BibIssue) => string;

/** Message of a lint issue, in the interface language. */
export type IssueTranslator = (issue: LintIssue) => string;

/**
 * Checks the edited text without compiling it (SPEC §3.2). Without project
 * context (index not loaded yet), only environments are checked, so that
 * references to other files are not reported as unknown.
 */
export function editorIssues(text: string, project: ProjectLintContext | null): LintIssue[] {
  const structure = extractStructure(text);
  const labelCounts = new Map(project?.labelCounts ?? []);
  for (const label of structure.labels) {
    labelCounts.set(label.name, (labelCounts.get(label.name) ?? 0) + 1);
  }
  const keys = new Set(project?.citationKeys ?? []);
  for (const item of structure.bibitems) keys.add(item.name);
  const issues = lintDocument(text, {
    labelCounts,
    citationKeys: keys.size === 0 ? null : keys,
  });
  return project === null ? issues.filter((issue) => issue.code.endsWith('Environment')) : issues;
}

/**
 * Markers of the syntax errors and duplicate keys of a `.bib` file. Keys of
 * the other files are only compared once the project index is known.
 */
export function bibtexMarkers(
  text: string,
  otherKeys: ReadonlySet<string> | undefined,
  translate: BibIssueTranslator,
  source: string,
): LintDiagnostic[] {
  return checkBibtex(text, otherKeys).issues.map((issue) => {
    // An empty range would be invisible: mark at least one character.
    const from = Math.min(issue.from, Math.max(text.length - 1, 0));
    return {
      from,
      to: Math.min(Math.max(issue.to, from + 1), text.length),
      severity: 'error',
      source,
      message: translate(issue),
    };
  });
}

/** Replaces the compilation markers of an editor. */
export const setCompileMarkers = StateEffect.define<LintDiagnostic[]>();

/**
 * Compilation markers, moved with the text as it is edited until the next
 * compilation replaces them.
 */
const compileMarkers = StateField.define<LintDiagnostic[]>({
  create: () => [],
  update(markers, transaction) {
    let next = markers;
    if (transaction.docChanged) {
      next = markers.map((marker) => {
        const from = transaction.changes.mapPos(marker.from, 1);
        return { ...marker, from, to: Math.max(from, transaction.changes.mapPos(marker.to, -1)) };
      });
    }
    for (const effect of transaction.effects) {
      if (effect.is(setCompileMarkers)) next = effect.value;
    }
    return next;
  },
});

/** Compilation markers of an editor state, where the edits since have moved them. */
export function compileMarkersOf(state: EditorState): readonly LintDiagnostic[] {
  return state.field(compileMarkers, false) ?? [];
}

export interface LintOptions {
  /** What the file is checked as while it is typed. */
  check: 'latex' | 'bibtex' | null;
  project: () => ProjectLintContext | null;
  translate: IssueTranslator;
  translateBib: BibIssueTranslator;
  /** Name shown for the markers of the editor's own checks. */
  source: string;
}

/**
 * One linter showing both the markers of the last compilation and those of
 * the checks made as the user types, which CodeMirror cannot keep apart.
 */
export function lintExtension(options: LintOptions): Extension {
  return [
    compileMarkers,
    linter(
      (view) => {
        const markers = [...view.state.field(compileMarkers)];
        if (options.check === 'bibtex') {
          return markers.concat(
            bibtexMarkers(
              view.state.doc.toString(),
              options.project()?.otherBibKeys,
              options.translateBib,
              options.source,
            ),
          );
        }
        if (options.check !== 'latex') return markers;
        for (const issue of editorIssues(view.state.doc.toString(), options.project())) {
          markers.push({
            from: issue.from,
            to: issue.to,
            severity: issue.severity,
            source: options.source,
            message: options.translate(issue),
          });
        }
        return markers;
      },
      {
        delay: 400,
        needsRefresh: (update) =>
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(setCompileMarkers)),
          ),
      },
    ),
  ];
}
