import { LineIndex, readGroup, scanCommands, skipOptionals, skipSpaces } from './scanner.js';

export const headingLevels = [
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
  'frame',
] as const;
export type HeadingLevel = (typeof headingLevels)[number];

/** Nesting depth of each level; Beamer frames sit below subsections. */
export const HEADING_DEPTH: Readonly<Record<HeadingLevel, number>> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
  frame: 4,
};

export interface Heading {
  level: HeadingLevel;
  /** Readable title, with simple markup removed; empty for an untitled frame. */
  title: string;
  starred: boolean;
  line: number;
  offset: number;
}

export interface Label {
  name: string;
  line: number;
}

export interface DefinedCommand {
  /** Without the backslash. */
  name: string;
  /** Number of arguments, optional one included. */
  args: number;
  /** Whether the first argument is optional. */
  optional: boolean;
  line: number;
}

export interface DefinedEnvironment {
  name: string;
  args: number;
  line: number;
}

export const includeKinds = [
  'input',
  'include',
  'subfile',
  'import',
  'graphics',
  'bibliography',
  'other',
] as const;
export type IncludeKind = (typeof includeKinds)[number];

export interface Include {
  kind: IncludeKind;
  /** File reference as written, relative to `directory` when set. */
  path: string;
  /** Directory given to `\import`-style commands. */
  directory?: string;
  line: number;
  offset: number;
}

export interface Structure {
  headings: Heading[];
  labels: Label[];
  commands: DefinedCommand[];
  environments: DefinedEnvironment[];
  includes: Include[];
}

const SECTION_COMMANDS = new Set<string>(headingLevels.filter((level) => level !== 'frame'));

const COMMAND_DEFINITIONS = new Set([
  'newcommand',
  'renewcommand',
  'providecommand',
  'DeclareRobustCommand',
]);
const DOCUMENT_COMMANDS = new Set([
  'NewDocumentCommand',
  'RenewDocumentCommand',
  'ProvideDocumentCommand',
  'DeclareDocumentCommand',
  'NewExpandableDocumentCommand',
]);
const ENVIRONMENT_DEFINITIONS = new Set(['newenvironment', 'renewenvironment']);
const DOCUMENT_ENVIRONMENTS = new Set([
  'NewDocumentEnvironment',
  'RenewDocumentEnvironment',
  'ProvideDocumentEnvironment',
  'DeclareDocumentEnvironment',
]);

/** Single-file inclusion commands whose last argument is a path. */
const PATH_COMMANDS: Readonly<Record<string, IncludeKind>> = {
  input: 'input',
  include: 'include',
  subfile: 'subfile',
  subfileinclude: 'subfile',
  includegraphics: 'graphics',
  addbibresource: 'bibliography',
  includepdf: 'other',
  lstinputlisting: 'other',
  inputminted: 'other',
  includestandalone: 'other',
};
const IMPORT_COMMANDS = new Set([
  'import',
  'subimport',
  'inputfrom',
  'subinputfrom',
  'includefrom',
]);

/**
 * Turns a sectioning argument into display text: drops `\label`, keeps the
 * arguments of formatting commands, removes braces and collapses spaces.
 */
export function plainTitle(raw: string): string {
  return raw
    .replace(/\\label\s*\{[^}]*\}/g, '')
    .replace(/\\(?:\\|newline)/g, ' ')
    .replace(/\\([%&#$_{}])/g, '$1')
    .replace(/\\[a-zA-Z@]+\*?(?:\s*\[[^\]]*\])?/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Counts the arguments of an xparse signature such as `m o O{x} +m`. */
function countSignature(spec: string): { args: number; optional: boolean } {
  let args = 0;
  let optional: boolean | null = null;
  let position = 0;
  while (position < spec.length) {
    const char = spec[position] ?? '';
    if (/[mrRvbsltgGdDeEoO]/.test(char)) {
      args += 1;
      optional ??= /[oOdDgGst]/.test(char);
      // Skip the default value or delimiters of O{..}, r(), d<> and similar.
      position += 1;
      while (spec[position] === '{' || spec[position] === '(' || spec[position] === '<') {
        const close = spec[position] === '{' ? '}' : spec[position] === '(' ? ')' : '>';
        const end = spec.indexOf(close, position);
        position = end === -1 ? spec.length : end + 1;
      }
      continue;
    }
    position += 1;
  }
  return { args, optional: optional ?? false };
}

/** Reads the command name defined by `\newcommand{\foo}` or `\newcommand\foo`. */
function definedName(text: string, from: number): { name: string; end: number } | null {
  const group = readGroup(text, from);
  if (group !== null) {
    const match = /^\s*\\([a-zA-Z@]+)\s*$/.exec(group.content);
    return match?.[1] === undefined ? null : { name: match[1], end: group.end };
  }
  const position = skipSpaces(text, from);
  const match = /^\\([a-zA-Z@]+)/.exec(text.slice(position, position + 200));
  return match?.[1] === undefined ? null : { name: match[1], end: position + match[0].length };
}

/** Extracts headings, labels, definitions and file references from one source file. */
export function extractStructure(text: string): Structure {
  const lines = new LineIndex(text);
  const structure: Structure = {
    headings: [],
    labels: [],
    commands: [],
    environments: [],
    includes: [],
  };

  for (const token of scanCommands(text)) {
    const { name, end, start } = token;
    const line = lines.lineOf(start);

    if (SECTION_COMMANDS.has(name)) {
      const { end: afterOptional } = skipOptionals(text, end);
      const title = readGroup(text, afterOptional);
      if (title !== null) {
        structure.headings.push({
          // The set holds exactly the non-frame heading levels.
          level: name as HeadingLevel,
          title: plainTitle(title.content),
          starred: token.starred,
          line,
          offset: start,
        });
      }
      continue;
    }

    switch (name) {
      case 'begin': {
        const environment = readGroup(text, end);
        if (environment?.content !== 'frame') break;
        // \begin{frame}<overlay>[options]{title}
        let position = environment.end;
        const overlay = readGroup(text, position, '<', '>');
        if (overlay !== null) position = overlay.end;
        position = skipOptionals(text, position).end;
        const title = text[skipSpaces(text, position)] === '{' ? readGroup(text, position) : null;
        structure.headings.push({
          level: 'frame',
          title: title === null ? '' : plainTitle(title.content),
          starred: false,
          line,
          offset: start,
        });
        break;
      }
      case 'frametitle': {
        const last = structure.headings.at(-1);
        const title = readGroup(text, skipOptionals(text, end).end);
        if (last?.level === 'frame' && last.title === '' && title !== null) {
          last.title = plainTitle(title.content);
        }
        break;
      }
      case 'label': {
        const label = readGroup(text, end);
        if (label !== null && label.content.trim() !== '') {
          structure.labels.push({ name: label.content.trim(), line });
        }
        break;
      }
      case 'def':
      case 'gdef':
      case 'edef':
      case 'xdef': {
        const match = /^\s*\\([a-zA-Z@]+)((?:#\d)*)/.exec(text.slice(end, end + 200));
        if (match?.[1] !== undefined) {
          structure.commands.push({
            name: match[1],
            args: (match[2] ?? '').length / 2,
            optional: false,
            line,
          });
        }
        break;
      }
      case 'DeclareMathOperator': {
        const defined = definedName(text, end);
        if (defined !== null) {
          structure.commands.push({ name: defined.name, args: 0, optional: false, line });
        }
        break;
      }
      case 'newtheorem': {
        const environment = readGroup(text, end);
        if (environment !== null) {
          structure.environments.push({ name: environment.content.trim(), args: 1, line });
        }
        break;
      }
      case 'bibliography': {
        const list = readGroup(text, end);
        for (const entry of list?.content.split(',') ?? []) {
          if (entry.trim() !== '') {
            structure.includes.push({
              kind: 'bibliography',
              path: entry.trim(),
              line,
              offset: start,
            });
          }
        }
        break;
      }
      default:
        break;
    }

    if (COMMAND_DEFINITIONS.has(name)) {
      const defined = definedName(text, end);
      if (defined === null) continue;
      const { optionals } = skipOptionals(text, defined.end);
      const args = Number.parseInt(optionals[0] ?? '0', 10);
      structure.commands.push({
        name: defined.name,
        args: Number.isNaN(args) ? 0 : args,
        optional: optionals.length > 1,
        line,
      });
    } else if (DOCUMENT_COMMANDS.has(name)) {
      const defined = definedName(text, end);
      const spec = defined === null ? null : readGroup(text, defined.end);
      if (defined !== null && spec !== null) {
        structure.commands.push({ name: defined.name, ...countSignature(spec.content), line });
      }
    } else if (ENVIRONMENT_DEFINITIONS.has(name)) {
      const environment = readGroup(text, end);
      if (environment === null) continue;
      const { optionals } = skipOptionals(text, environment.end);
      const args = Number.parseInt(optionals[0] ?? '0', 10);
      structure.environments.push({
        name: environment.content.trim(),
        args: Number.isNaN(args) ? 0 : args,
        line,
      });
    } else if (DOCUMENT_ENVIRONMENTS.has(name)) {
      const environment = readGroup(text, end);
      const spec = environment === null ? null : readGroup(text, environment.end);
      if (environment !== null && spec !== null) {
        structure.environments.push({
          name: environment.content.trim(),
          args: countSignature(spec.content).args,
          line,
        });
      }
    } else if (name in PATH_COMMANDS) {
      const target = readGroup(text, skipOptionals(text, end).end);
      const kind = PATH_COMMANDS[name];
      if (target !== null && kind !== undefined && target.content.trim() !== '') {
        structure.includes.push({ kind, path: target.content.trim(), line, offset: start });
      }
    } else if (IMPORT_COMMANDS.has(name)) {
      const directory = readGroup(text, end);
      const file = directory === null ? null : readGroup(text, directory.end);
      if (directory !== null && file !== null) {
        structure.includes.push({
          kind: 'import',
          path: file.content.trim(),
          directory: directory.content.trim(),
          line,
          offset: start,
        });
      }
    }
  }
  return structure;
}
