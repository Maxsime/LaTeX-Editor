/** Compact view of a project, from `packages/latex-index` and the file tree. */
export interface ProjectSummary {
  mainFile: string | null;
  files: { path: string; kind: 'text' | 'binary' | 'folder' }[];
  outline: { level: number; title: string; file: string; line: number }[];
  labels: string[];
  citationKeys: string[];
  packages: string[];
  commands: { name: string; arguments: number }[];
}

/** The file the user is looking at. */
export interface CurrentFile {
  path: string;
  text: string;
  cursor?: number | undefined;
  selection?: { from: number; to: number } | undefined;
}

export interface LogError {
  file?: string | undefined;
  line?: number | undefined;
  message: string;
}

export interface ContextInput {
  project: ProjectSummary;
  current?: CurrentFile | undefined;
  logErrors: LogError[];
  /** Characters the whole context may take, from the model's window. */
  budget: number;
}

export interface BuiltContext {
  /** Same for every request on an unchanged project: the cacheable prefix. */
  stable: string;
  /** What changes from one request to the next. */
  variable: string;
}

/** Characters per token used to turn a window in tokens into a budget in characters. */
const CHARS_PER_TOKEN = 3;

/** Share of the model's window given to the context; the rest is for the conversation and tools. */
export function contextBudget(contextTokens: number): number {
  return Math.floor(contextTokens * CHARS_PER_TOKEN * 0.4);
}

function listed(title: string, items: string[], limit: number): string {
  if (items.length === 0) return `${title}: (none)`;
  const shown = items.slice(0, limit);
  const more = items.length > limit ? ` (+${String(items.length - limit)} more)` : '';
  return `${title}: ${shown.join(', ')}${more}`;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 20))}\n[... truncated]`;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * The window of `text` around `center`, cut on line boundaries, with the
 * numbers of its first and last lines.
 */
export function windowAround(
  text: string,
  center: number,
  size: number,
): { text: string; firstLine: number; lastLine: number; complete: boolean } {
  if (text.length <= size) {
    return { text, firstLine: 1, lastLine: lineAt(text, text.length), complete: true };
  }
  let start = Math.max(0, Math.min(center - Math.floor(size / 2), text.length - size));
  let end = Math.min(text.length, start + size);
  // Whole lines only: a cut line would mislead a model quoting text for a replacement.
  if (start > 0) {
    const next = text.indexOf('\n', start);
    start = next === -1 || next >= end ? start : next + 1;
  }
  if (end < text.length) {
    const previous = text.lastIndexOf('\n', end);
    end = previous > start ? previous : end;
  }
  return {
    text: text.slice(start, end),
    firstLine: lineAt(text, start),
    lastLine: lineAt(text, end),
    complete: false,
  };
}

/**
 * Assembles what the model knows without calling a tool (SPEC §6.8): a stable
 * index of the project first, so that providers with a prompt cache reuse it,
 * then the current file around the cursor, the selection and the last errors.
 */
export function buildContext({ project, current, logErrors, budget }: ContextInput): BuiltContext {
  const stableBudget = Math.floor(budget * 0.35);
  const files = project.files.filter((file) => file.kind !== 'folder').map((file) => file.path);
  const outline = project.outline.map(
    (entry) =>
      `${'  '.repeat(Math.max(0, entry.level - 1))}${entry.title} (${entry.file}:${String(entry.line)})`,
  );
  const stable = clip(
    [
      '# Project index',
      `Main file: ${project.mainFile ?? '(none)'}`,
      listed('Files', files, 300),
      listed('Packages', project.packages, 100),
      listed('Labels', project.labels, 300),
      listed('Citation keys', project.citationKeys, 500),
      listed(
        'Defined commands',
        project.commands.map((command) => `\\${command.name}[${String(command.arguments)}]`),
        200,
      ),
      'Outline:',
      outline.length === 0 ? '(empty)' : outline.slice(0, 300).join('\n'),
    ].join('\n'),
    stableBudget,
  );

  const parts: string[] = [];
  let remaining = budget - stable.length;
  if (logErrors.length > 0) {
    const errors = clip(
      logErrors
        .slice(0, 20)
        .map(
          (error) =>
            `- ${error.file ?? '?'}${error.line === undefined ? '' : `:${String(error.line)}`}: ${error.message}`,
        )
        .join('\n'),
      Math.floor(remaining * 0.15),
    );
    parts.push(`# Errors of the last compilation\n${errors}`);
    remaining -= errors.length;
  }
  if (current !== undefined) {
    const { selection } = current;
    if (selection !== undefined && selection.to > selection.from) {
      const selected = clip(
        current.text.slice(selection.from, selection.to),
        Math.floor(remaining * 0.3),
      );
      parts.push(
        `# Selection in ${current.path} (from line ${String(lineAt(current.text, selection.from))})\n${selected}`,
      );
      remaining -= selected.length;
    }
    const center = selection?.from ?? current.cursor ?? 0;
    const window = windowAround(current.text, center, Math.max(1000, remaining - 200));
    const where = window.complete
      ? 'whole file'
      : `lines ${String(window.firstLine)} to ${String(window.lastLine)}; use read_file for the rest`;
    const cursor =
      current.cursor === undefined
        ? ''
        : `, cursor on line ${String(lineAt(current.text, current.cursor))}`;
    parts.push(`# Current file: ${current.path} (${where}${cursor})\n${window.text}`);
  }
  return { stable, variable: parts.join('\n\n') };
}
