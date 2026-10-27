import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippetCompletion,
} from '@codemirror/autocomplete';
import { CITATION_COMMANDS, extractStructure, REFERENCE_COMMANDS } from '@galley/latex-index';
import { builtinCommands, builtinEnvironments, FILE_ARGUMENT_COMMANDS } from './latex-data.js';
import { CLASS_OPTIONS, PACKAGE_OPTIONS } from './package-options.js';

/** What the project contributes to completion, refreshed from the API. */
export interface CompletionSources {
  commands: readonly { name: string; args: number; optional: boolean }[];
  environments: readonly string[];
  /** Project-relative paths of every file. */
  paths: readonly string[];
  /** Directory of the file being edited, for paths relative to it. */
  directory: string;
  /** Labels of the project's other files; those of the edited file are read from its text. */
  labels: readonly string[];
  citations: readonly CitationEntry[];
}

/** A bibliography entry offered after `\cite{`. */
export interface CitationEntry {
  key: string;
  title: string | null;
  authors: readonly string[];
  year: string | null;
}

/**
 * Snippet template for a command, e.g. `\frac{#{}}{#{}}`. Optional arguments
 * are left out: most uses skip them, and typing `[` stays easy.
 */
export function commandTemplate(name: string, args: number): string {
  return `\\${name}${'{#{}}'.repeat(args)}`;
}

function commandOptions(sources: CompletionSources): Completion[] {
  const seen = new Set<string>();
  const options: Completion[] = [];
  const add = (name: string, args: number, detail: string | undefined) => {
    if (seen.has(name)) return;
    seen.add(name);
    const label = `\\${name}`;
    const base = { label, type: 'function', ...(detail === undefined ? {} : { detail }) };
    options.push(args > 0 ? snippetCompletion(commandTemplate(name, args), base) : base);
  };
  // Project definitions first: they win over a built-in of the same name.
  for (const command of sources.commands) {
    add(command.name, command.optional ? command.args - 1 : command.args, undefined);
  }
  for (const command of builtinCommands) add(command.name, command.args, command.pkg);
  return options;
}

/** Completes `\name` from the built-in vocabulary and the project's definitions. */
export function completeCommand(
  context: CompletionContext,
  sources: CompletionSources,
): CompletionResult | null {
  const word = context.matchBefore(/\\[a-zA-Z@]*/);
  if (word === null || (word.from === word.to && !context.explicit)) return null;
  // `\begin{` is handled by the environment source.
  return { from: word.from, options: commandOptions(sources), validFor: /^\\[a-zA-Z@]*$/ };
}

/** Completes the name after `\begin{` and inserts the matching `\end`. */
export function completeEnvironment(
  context: CompletionContext,
  sources: CompletionSources,
): CompletionResult | null {
  const match = context.matchBefore(/\\(begin|end)\{[a-zA-Z*]*/);
  if (match === null) return null;
  const isBegin = match.text.startsWith('\\begin');
  const from = match.from + match.text.indexOf('{') + 1;
  const names = [...new Set([...sources.environments, ...builtinEnvironments])];
  // A closing brace typed or auto-inserted after the cursor is consumed by the snippet.
  const after = context.state.sliceDoc(context.pos, context.pos + 1);
  const to = after === '}' ? context.pos + 1 : context.pos;
  return {
    from,
    to,
    options: names.map((name) =>
      isBegin
        ? snippetCompletion(`${name}}\n\t#{}\n\\end{${name}}`, { label: name, type: 'type' })
        : { label: name, type: 'type', apply: `${name}}` },
    ),
    validFor: /^[a-zA-Z*]*$/,
  };
}

/** Relative path from `directory` to `path`, both project-relative. */
export function relativeTo(directory: string, path: string): string {
  if (directory === '') return path;
  const from = directory.split('/');
  const to = path.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1;
  return [...Array<string>(from.length - common).fill('..'), ...to.slice(common)].join('/');
}

/** Completes file names inside `\input{`, `\includegraphics[...]{` and similar. */
export function completeFilePath(
  context: CompletionContext,
  sources: CompletionSources,
): CompletionResult | null {
  const match = context.matchBefore(/\\([a-zA-Z]+)(?:\[[^\]]*\])?\{[^}{\s]*/);
  const command = match === null ? undefined : /^\\([a-zA-Z]+)/.exec(match.text)?.[1];
  if (match === null || command === undefined) return null;
  const extensions = FILE_ARGUMENT_COMMANDS[command];
  if (extensions === undefined) return null;
  const from = match.from + match.text.lastIndexOf('{') + 1;
  // TeX resolves \input against the main file's folder; most projects keep it at the root.
  const strip = command === 'input' || command === 'include' || command === 'subfile';
  const options = sources.paths
    .filter(
      (path) =>
        extensions.length === 0 ||
        extensions.some((extension) => path.toLowerCase().endsWith(extension)),
    )
    .map((path) => {
      const shown = command === 'subfile' ? relativeTo(sources.directory, path) : path;
      return {
        label: shown,
        type: 'text',
        apply: strip && shown.toLowerCase().endsWith('.tex') ? shown.slice(0, -4) : shown,
      };
    });
  return { from, options, validFor: /^[^}{\s]*$/ };
}

/** Short form of an entry's authors and year, e.g. `Knuth et al. (1984)`. */
export function citationDetail(entry: CitationEntry): string | undefined {
  const [first] = entry.authors;
  // Authors come as "Last, First"; the family name is enough to recognise an entry.
  const family = first?.split(',')[0]?.trim();
  const who = family === undefined ? '' : entry.authors.length > 1 ? `${family} et al.` : family;
  const when = entry.year === null ? '' : `(${entry.year})`;
  const detail = [who, when].filter((part) => part !== '').join(' ');
  return detail === '' ? undefined : detail;
}

/** Start of the key being typed in a comma-separated argument. */
function keyStart(argumentStart: number, typed: string): number {
  const comma = typed.lastIndexOf(',');
  const from = comma === -1 ? 0 : comma + 1;
  return argumentStart + from + (typed.length - from - typed.slice(from).trimStart().length);
}

/**
 * Completes labels after `\ref{` and its variants, and citation keys after
 * `\cite{` and its variants, key by key in a comma-separated list.
 */
export function completeKey(
  context: CompletionContext,
  sources: CompletionSources,
): CompletionResult | null {
  // Earlier groups belong to multi-cite commands: `\cites[1]{a}[2]{b`.
  const match = context.matchBefore(/\\([a-zA-Z]+)\*?(?:\[[^\]]*\]|\([^)]*\)|\{[^{}]*\})*\{[^{}]*/);
  const command = match === null ? undefined : /^\\([a-zA-Z]+)/.exec(match.text)?.[1];
  if (match === null || command === undefined) return null;
  const brace = match.from + match.text.lastIndexOf('{') + 1;
  const from = keyStart(brace, context.state.sliceDoc(brace, context.pos));
  if (REFERENCE_COMMANDS.has(command)) {
    const local = extractStructure(context.state.doc.toString()).labels.map((label) => label.name);
    const names = [...new Set([...local, ...sources.labels])];
    return {
      from,
      options: names.map((name) => ({ label: name, type: 'variable' })),
      validFor: /^[^,}\s]*$/,
    };
  }
  if (CITATION_COMMANDS.has(command)) {
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const entry of sources.citations) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      const detail = citationDetail(entry);
      options.push({
        label: entry.key,
        type: 'constant',
        ...(detail === undefined ? {} : { detail }),
        ...(entry.title === null ? {} : { info: entry.title }),
      });
    }
    return { from, options, validFor: /^[^,}\s]*$/ };
  }
  return null;
}

/** Commands whose optional argument lists class or package options. */
const OPTION_COMMANDS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  documentclass: CLASS_OPTIONS,
  LoadClass: CLASS_OPTIONS,
  usepackage: PACKAGE_OPTIONS,
  RequirePackage: PACKAGE_OPTIONS,
};

/**
 * Completes the options in `\usepackage[...]{name}` and `\documentclass[...]{name}`.
 * The name follows the cursor, so it is read from the rest of the line.
 */
export function completeOption(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\\([a-zA-Z]+)\[[^\]]*/);
  const command = match === null ? undefined : /^\\([a-zA-Z]+)/.exec(match.text)?.[1];
  const table = command === undefined ? undefined : OPTION_COMMANDS[command];
  if (match === null || table === undefined) return null;
  const rest = context.state.sliceDoc(context.pos, context.state.doc.lineAt(context.pos).to);
  const names = /^[^\]]*\]\s*\{([^}]*)\}/.exec(rest)?.[1];
  if (names === undefined) return null;
  const options = [...new Set(names.split(',').flatMap((name) => table[name.trim()] ?? []))];
  if (options.length === 0) return null;
  const bracket = match.from + match.text.indexOf('[') + 1;
  return {
    from: keyStart(bracket, context.state.sliceDoc(bracket, context.pos)),
    options: options.map((option) => ({ label: option, type: 'property' })),
    validFor: /^[^,\]\s=]*$/,
  };
}

/** Completes package names in `\usepackage{` and class names in `\documentclass{`. */
export function completePackageName(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(
    /\\(usepackage|RequirePackage|documentclass)(?:\[[^\]]*\])?\{[^{}]*/,
  );
  if (match === null) return null;
  const table = match.text.startsWith('\\documentclass') ? CLASS_OPTIONS : PACKAGE_OPTIONS;
  const brace = match.from + match.text.lastIndexOf('{') + 1;
  return {
    from: keyStart(brace, context.state.sliceDoc(brace, context.pos)),
    options: Object.keys(table).map((name) => ({ label: name, type: 'namespace' })),
    validFor: /^[^,}\s]*$/,
  };
}

/** A single completion source combining the contexts above. */
export function latexCompletionSource(
  sources: () => CompletionSources,
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const current = sources();
    return (
      completeFilePath(context, current) ??
      completeKey(context, current) ??
      completeOption(context) ??
      completePackageName(context) ??
      completeEnvironment(context, current) ??
      completeCommand(context, current)
    );
  };
}
