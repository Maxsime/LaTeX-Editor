import { readGroup, scanCommands, skipOptionals, skipSpaces } from './scanner.js';

/** Commands whose argument is a list of labels (`\cref{a,b}`). */
export const REFERENCE_COMMANDS: ReadonlySet<string> = new Set([
  'ref',
  'eqref',
  'pageref',
  'autoref',
  'Autoref',
  'nameref',
  'Nameref',
  'vref',
  'Vref',
  'vpageref',
  'cref',
  'Cref',
  'cpageref',
  'Cpageref',
  'labelcref',
  'namecref',
  'nameCref',
  'crefrange',
  'Crefrange',
  'cpagerefrange',
  'subref',
]);

/** Commands whose argument is a list of citation keys (natbib, BibLaTeX). */
export const CITATION_COMMANDS: ReadonlySet<string> = new Set([
  'cite',
  'Cite',
  'nocite',
  'citep',
  'citet',
  'Citep',
  'Citet',
  'citealp',
  'citealt',
  'Citealp',
  'Citealt',
  'citeauthor',
  'Citeauthor',
  'citeyear',
  'citeyearpar',
  'citetitle',
  'citeurl',
  'citedate',
  'parencite',
  'Parencite',
  'textcite',
  'Textcite',
  'autocite',
  'Autocite',
  'footcite',
  'footcitetext',
  'smartcite',
  'Smartcite',
  'supercite',
  'fullcite',
  'footfullcite',
  'cites',
  'Cites',
  'parencites',
  'Parencites',
  'textcites',
  'Textcites',
  'autocites',
  'Autocites',
  'footcites',
  'smartcites',
  'supercites',
]);

/** A label or citation key used in a source file. */
export interface KeyUse {
  kind: 'reference' | 'citation';
  command: string;
  key: string;
  /** Offsets of the key itself. */
  from: number;
  to: number;
}

/** Keys of a comma-separated argument, with their offsets in the text. */
function keysOf(content: string, offset: number): { key: string; from: number; to: number }[] {
  const keys: { key: string; from: number; to: number }[] = [];
  let position = 0;
  for (const part of content.split(',')) {
    const leading = part.length - part.trimStart().length;
    const key = part.trim();
    if (key !== '' && !key.includes('\\') && !key.includes('#')) {
      const from = offset + position + leading;
      keys.push({ key, from, to: from + key.length });
    }
    position += part.length + 1;
  }
  return keys;
}

/**
 * Finds the labels referenced and the keys cited in a source file. Multi-cite
 * commands (`\cites[pre][post]{a}[post]{b}`) contribute every group.
 */
export function extractKeyUses(text: string): KeyUse[] {
  const uses: KeyUse[] = [];
  for (const token of scanCommands(text)) {
    const reference = REFERENCE_COMMANDS.has(token.name);
    const citation = CITATION_COMMANDS.has(token.name);
    if (!reference && !citation) continue;
    const kind = reference ? 'reference' : 'citation';
    const many = citation && token.name.endsWith('cites');
    let position = token.end;
    for (;;) {
      // Pre- and postnotes; `\cites` also takes one `(...)` multiprenote.
      position = skipOptionals(text, position).end;
      if (many) {
        const prenote = readGroup(text, position, '(', ')');
        if (prenote !== null) position = skipOptionals(text, prenote.end).end;
      }
      const group = readGroup(text, position);
      if (group === null) break;
      for (const key of keysOf(group.content, group.start + 1)) {
        uses.push({ kind, command: token.name, ...key });
      }
      position = group.end;
      if (!many) break;
    }
  }
  return uses;
}

/** Commands whose arguments define code: the environments they contain need not balance. */
const DEFINITION_GROUPS: Readonly<Record<string, number>> = {
  newcommand: 1,
  renewcommand: 1,
  providecommand: 1,
  DeclareRobustCommand: 1,
  newenvironment: 2,
  renewenvironment: 2,
  NewDocumentCommand: 2,
  RenewDocumentCommand: 2,
  ProvideDocumentCommand: 2,
  DeclareDocumentCommand: 2,
  NewExpandableDocumentCommand: 2,
  NewDocumentEnvironment: 3,
  RenewDocumentEnvironment: 3,
  ProvideDocumentEnvironment: 3,
  DeclareDocumentEnvironment: 3,
};

/** Offset just after a definition, so that its body is not linted as document text. */
function definitionEnd(text: string, name: string, from: number): number {
  if (name === 'def' || name === 'gdef' || name === 'edef' || name === 'xdef') {
    // \def\name#1#2{body}: the parameter text runs up to the body's brace.
    const brace = text.indexOf('{', from);
    const body = brace === -1 ? null : readGroup(text, brace);
    return body?.end ?? from;
  }
  const groups = DEFINITION_GROUPS[name];
  if (groups === undefined) return from;
  // The defined name, as a group or a bare control sequence.
  let position = skipSpaces(text, from);
  const nameGroup = readGroup(text, position);
  if (nameGroup !== null) position = nameGroup.end;
  else {
    const match = /^\\[a-zA-Z@]+/.exec(text.slice(position, position + 200));
    position += match?.[0].length ?? 0;
  }
  for (let index = 0; index < groups; index += 1) {
    position = skipOptionals(text, position).end;
    const group = readGroup(text, position);
    if (group === null) break;
    position = group.end;
  }
  return position;
}

export type LintCode =
  | 'mismatchedEnvironment'
  | 'unclosedEnvironment'
  | 'unopenedEnvironment'
  | 'duplicateLabel'
  | 'unknownReference'
  | 'unknownCitation';

/** A problem found in a source file without compiling it (SPEC §3.2). */
export interface LintIssue {
  code: LintCode;
  severity: 'error' | 'warning';
  from: number;
  to: number;
  /** The environment, label or key concerned. */
  name: string;
  /** For a mismatched `\end`, the environment it should close. */
  expected?: string;
}

/** What the rest of the project knows, for checks that span files. */
export interface LintContext {
  /** Number of definitions of each label across the project, this file included. */
  labelCounts: ReadonlyMap<string, number>;
  /** Known citation keys, or null when the project has no bibliography to check against. */
  citationKeys: ReadonlySet<string> | null;
}

interface OpenEnvironment {
  name: string;
  from: number;
  to: number;
}

function environmentIssues(text: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const stack: OpenEnvironment[] = [];
  let skipUntil = 0;
  for (const token of scanCommands(text)) {
    if (token.start < skipUntil) continue;
    if (token.name !== 'begin' && token.name !== 'end') {
      skipUntil = Math.max(skipUntil, definitionEnd(text, token.name, token.end));
      continue;
    }
    const group = readGroup(text, token.end);
    if (group === null) continue;
    const name = group.content.trim();
    const range = { from: token.start, to: group.end };
    if (token.name === 'begin') {
      stack.push({ name, ...range });
      continue;
    }
    const top = stack.at(-1);
    if (top?.name === name) {
      stack.pop();
      continue;
    }
    const depth = stack.map((open) => open.name).lastIndexOf(name);
    if (depth === -1) {
      // Possibly opened in the file that includes this one.
      issues.push({ code: 'unopenedEnvironment', severity: 'warning', name, ...range });
      continue;
    }
    issues.push({
      code: 'mismatchedEnvironment',
      severity: 'error',
      name,
      expected: top?.name ?? '',
      ...range,
    });
    // The environments between the one closed here and the innermost, which the
    // message above names, were left open too.
    for (const open of stack.splice(depth).slice(1, -1)) {
      issues.push({
        code: 'unclosedEnvironment',
        severity: 'error',
        name: open.name,
        from: open.from,
        to: open.to,
      });
    }
  }
  for (const open of stack) {
    // Possibly closed in another file; only a warning.
    issues.push({
      code: 'unclosedEnvironment',
      severity: 'warning',
      name: open.name,
      from: open.from,
      to: open.to,
    });
  }
  return issues;
}

function labelIssues(text: string, context: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const token of scanCommands(text)) {
    if (token.name !== 'label') continue;
    const group = readGroup(text, token.end);
    const name = group?.content.trim() ?? '';
    if (group === null || name === '') continue;
    if ((context.labelCounts.get(name) ?? 0) > 1) {
      const from = group.start + 1 + group.content.indexOf(name);
      issues.push({
        code: 'duplicateLabel',
        severity: 'warning',
        name,
        from,
        to: from + name.length,
      });
    }
  }
  return issues;
}

function keyIssues(text: string, context: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const use of extractKeyUses(text)) {
    if (use.kind === 'reference' && !context.labelCounts.has(use.key)) {
      issues.push({
        code: 'unknownReference',
        severity: 'warning',
        name: use.key,
        from: use.from,
        to: use.to,
      });
    }
    if (
      use.kind === 'citation' &&
      context.citationKeys !== null &&
      use.key !== '*' &&
      !context.citationKeys.has(use.key)
    ) {
      issues.push({
        code: 'unknownCitation',
        severity: 'warning',
        name: use.key,
        from: use.from,
        to: use.to,
      });
    }
  }
  return issues;
}

/**
 * Checks a source file for unbalanced environments, duplicate labels and
 * references or citations to unknown keys, in offset order. Environments
 * inside definitions (`\newcommand`, `\newenvironment`...) are not checked.
 */
export function lintDocument(text: string, context: LintContext): LintIssue[] {
  return [
    ...environmentIssues(text),
    ...labelIssues(text, context),
    ...keyIssues(text, context),
  ].sort((a, b) => a.from - b.from);
}
