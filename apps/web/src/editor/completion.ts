import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippetCompletion,
} from '@codemirror/autocomplete';
import { builtinCommands, builtinEnvironments, FILE_ARGUMENT_COMMANDS } from './latex-data.js';

/** What the project contributes to completion, refreshed from the API. */
export interface CompletionSources {
  commands: readonly { name: string; args: number; optional: boolean }[];
  environments: readonly string[];
  /** Project-relative paths of every file. */
  paths: readonly string[];
  /** Directory of the file being edited, for paths relative to it. */
  directory: string;
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

/** A single completion source combining the three contexts above. */
export function latexCompletionSource(
  sources: () => CompletionSources,
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const current = sources();
    return (
      completeFilePath(context, current) ??
      completeEnvironment(context, current) ??
      completeCommand(context, current)
    );
  };
}
