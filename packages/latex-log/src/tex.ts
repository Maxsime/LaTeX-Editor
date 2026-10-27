import { type PathContext, resolveLogPath } from './paths.js';
import type { LogEntry } from './types.js';

/** Options of {@link parseTexLog}. */
export interface TexLogOptions extends PathContext {
  /** Project path of the main file, blamed when the log names no file. */
  mainFile: string;
}

/** `file:line: message`, printed for errors under `-file-line-error`. */
const FILE_LINE = /^((?:\/|\.{1,2}\/|[^\s:/][^\s:]*\/)?[^\s:]*\.[A-Za-z0-9]+):(\d+): (.*)$/;
/** Source excerpt of an error: `l.12 text read so far`, the rest on the next line. */
const CONTEXT_LINE = /^l\.(\d+) ?(.*)$/;
const WARNING =
  /^(?:LaTeX (Font) Warning|(LaTeX) Warning|(?:Package|Class|Module) ([^\s]+) Warning|(pdfTeX) warning(?: \([^)]*\))?): (.*)$/;
const BADBOX = /^(?:Over|Under)full \\[hv]box \(.*?\) .*$/;
const INPUT_LINE = /on input line (\d+)\.?/;
const BOX_LINES = /lines? (\d+)/;
const RUNAWAY = /^Runaway (?:argument|definition|text|preamble)\?$/;
/** Errors that only report the abort of a run already explained by an earlier error. */
const ABORT_MESSAGES = [/^Emergency stop\.?$/, /==> Fatal error occurred/];
/** File name right after an opening parenthesis: quoted, or up to a space or parenthesis. */
const OPENED_FILE = /^"([^"]+)"|^([^\s()"[\]{}]+)/;

interface Located {
  file: string | null;
  externalFile?: string;
}

/** Tracks the files TeX has open, from the parentheses of the log. */
class FileStack {
  private readonly names: (string | null)[] = [];

  /** Updates the stack with the parentheses of one log line. */
  scan(line: string): void {
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '(') {
        const match = OPENED_FILE.exec(line.slice(index + 1));
        const name = match?.[1] ?? match?.[2] ?? null;
        // Parentheses of ordinary text are balanced too; a placeholder keeps them paired.
        this.names.push(name !== null && looksLikeFile(name) ? name : null);
      } else if (char === ')') {
        this.names.pop();
      }
    }
  }

  /** Innermost open file, as TeX printed it. */
  current(): string | null {
    for (let index = this.names.length - 1; index >= 0; index -= 1) {
      const name = this.names[index];
      if (name !== null && name !== undefined) return name;
    }
    return null;
  }
}

function looksLikeFile(name: string): boolean {
  return /\.[A-Za-z0-9]{1,12}$/.test(name) || name.startsWith('/') || name.startsWith('./');
}

function locate(raw: string | null, options: TexLogOptions): Located {
  if (raw === null) return { file: options.mainFile };
  const resolved = resolveLogPath(raw, options);
  if (resolved.kind === 'project') return { file: resolved.path };
  if (resolved.kind === 'generated') return { file: null };
  return { file: null, externalFile: resolved.path };
}

/**
 * Reads the body of an error, up to the blank line that ends TeX's help text:
 * its `l.N` excerpt gives the line when the header did not.
 */
function readErrorBody(
  lines: readonly string[],
  start: number,
): { next: number; line: number | null; context: string; raw: string[] } {
  let line: number | null = null;
  let context = '';
  const raw: string[] = [];
  let index = start;
  for (; index < lines.length && index < start + 40; index += 1) {
    const text = lines[index] ?? '';
    if (text.trim() === '') break;
    if (text.startsWith('! ') || FILE_LINE.test(text)) break;
    raw.push(text);
    const excerpt = CONTEXT_LINE.exec(text);
    if (excerpt && line === null) {
      line = Number(excerpt[1]);
      const rest = lines[index + 1] ?? '';
      context = `${text}\n${rest}`.trimEnd();
    }
  }
  return { next: index, line, context, raw };
}

/**
 * Extracts errors, warnings and bad boxes from a TeX log written with
 * `-file-line-error` and `max_print_line=10000`, so that no line is wrapped.
 */
export function parseTexLog(log: string, options: TexLogOptions): LogEntry[] {
  const lines = log.split(/\r?\n/);
  const stack = new FileStack();
  const entries: LogEntry[] = [];
  let runaway: string | undefined;

  const pushError = (
    header: string,
    message: string,
    where: Located,
    headerLine: number | null,
    bodyStart: number,
  ): number => {
    const body = readErrorBody(lines, bodyStart);
    const entry: LogEntry = {
      level: 'error',
      source: 'tex',
      ...where,
      line: headerLine ?? body.line,
      message: message.trim(),
      context: body.context,
      raw: [header, ...body.raw].join('\n'),
    };
    if (runaway !== undefined) {
      entry.runaway = runaway;
      runaway = undefined;
    }
    entries.push(entry);
    return body.next;
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    const fileLine = FILE_LINE.exec(line);
    if (fileLine) {
      const [, path = '', lineNumber = '0', message = ''] = fileLine;
      index = pushError(line, message, locate(path, options), Number(lineNumber), index + 1);
      continue;
    }

    if (line.startsWith('! ')) {
      index = pushError(line, line.slice(2), locate(stack.current(), options), null, index + 1);
      continue;
    }

    if (RUNAWAY.test(line)) {
      runaway = (lines[index + 1] ?? '').trim();
      index += 2;
      continue;
    }

    const warning = WARNING.exec(line);
    if (warning) {
      const name = warning[1] ?? warning[2] ?? warning[3] ?? warning[4] ?? '';
      const parts = [warning[5] ?? ''];
      const raw = [line];
      // \MessageBreak continues a warning on lines prefixed by `(name)`.
      const prefix = `(${name})`;
      let next = index + 1;
      while (next < lines.length && (lines[next] ?? '').startsWith(prefix)) {
        const continued = lines[next] ?? '';
        raw.push(continued);
        parts.push(continued.slice(prefix.length).trim());
        next += 1;
      }
      const message = parts.join(' ').trim();
      const inputLine = INPUT_LINE.exec(message);
      entries.push({
        level: 'warning',
        source: 'tex',
        ...locate(stack.current(), options),
        line: inputLine ? Number(inputLine[1]) : null,
        message: name === 'LaTeX' || name === 'pdfTeX' ? message : `${name}: ${message}`,
        context: '',
        raw: raw.join('\n'),
      });
      index = next;
      continue;
    }

    if (BADBOX.test(line)) {
      const boxLine = BOX_LINES.exec(line);
      entries.push({
        level: 'badbox',
        source: 'tex',
        ...locate(stack.current(), options),
        line: boxLine ? Number(boxLine[1]) : null,
        message: line.trim(),
        context: '',
        raw: line,
      });
      // The box dump that follows quotes document text, whose parentheses mean nothing.
      index += 1;
      while (index < lines.length && (lines[index] ?? '').trim() !== '') index += 1;
      continue;
    }

    stack.scan(line);
    index += 1;
  }

  return dropAbortNoise(entries);
}

/**
 * Removes "Emergency stop" and "Fatal error" entries when another error explains
 * them, after lending their location to an earlier error that had none.
 */
function dropAbortNoise(entries: LogEntry[]): LogEntry[] {
  const isAbort = (entry: LogEntry) =>
    entry.level === 'error' && ABORT_MESSAGES.some((pattern) => pattern.test(entry.message));
  const real = entries.filter((entry) => entry.level === 'error' && !isAbort(entry));
  if (real.length === 0) return entries;
  for (const abort of entries.filter(isAbort)) {
    const previous = real.filter((entry) => entries.indexOf(entry) < entries.indexOf(abort)).at(-1);
    if (previous?.line === null && abort.line !== null) {
      previous.line = abort.line;
      previous.file = abort.file;
      if (previous.context === '') previous.context = abort.context;
    }
  }
  return entries.filter((entry) => !isAbort(entry));
}
