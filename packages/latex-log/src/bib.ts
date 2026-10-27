import { type PathContext, resolveLogPath } from './paths.js';
import type { LogEntry } from './types.js';

/** `[123] Biber.pm:456> WARN - message`, as written in a Biber `.blg`. */
const BIBER_LINE = /^\[\d+\] [^>]*> (WARN|ERROR) - (.*)$/;
/** BibTeX places the location of a database error after the message: `---line 5 of file refs.bib`. */
const BIBTEX_LOCATION = /---line (\d+) of file (.+)$/;
const BIBTEX_WARNING = /^Warning--(.*)$/;
const BIBTEX_FATAL = /^I couldn't open (?:database|style|auxiliary) file (.+)$/;

function bibFile(raw: string, context: PathContext): Pick<LogEntry, 'file' | 'externalFile'> {
  const resolved = resolveLogPath(raw, context);
  if (resolved.kind === 'project') return { file: resolved.path };
  return { file: null, externalFile: resolved.path };
}

/**
 * Extracts warnings and errors from a Biber `.blg`. Biber reads a temporary
 * copy of each database, so the file is taken from the `(name.bib)` or
 * `name.bib` the message quotes.
 */
export function parseBiberLog(blg: string, context: PathContext): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of blg.split(/\r?\n/)) {
    const match = BIBER_LINE.exec(line);
    if (!match) continue;
    const [, level = 'WARN', message = ''] = match;
    const quoted = /\(([^()\s]+\.bib)\)|'([^'\s]+\.bib)'/.exec(message);
    const fileName = quoted?.[1] ?? quoted?.[2];
    const lineMatch = /\bline (\d+)\b/.exec(message);
    entries.push({
      level: level === 'ERROR' ? 'error' : 'warning',
      source: 'biber',
      ...(fileName === undefined ? { file: null } : bibFile(fileName, context)),
      line: lineMatch ? Number(lineMatch[1]) : null,
      message: message.trim(),
      context: '',
      raw: line,
    });
  }
  return entries;
}

/** Extracts warnings and errors from a BibTeX `.blg`. */
export function parseBibtexLog(blg: string, context: PathContext): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = blg.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const warning = BIBTEX_WARNING.exec(line);
    if (warning) {
      // Some warnings are located on the following line, e.g. `--line 4 of file refs.bib`.
      const location = /^--line (\d+) of file (.+)$/.exec(lines[index + 1] ?? '');
      entries.push({
        level: 'warning',
        source: 'bibtex',
        ...(location ? bibFile(location[2] ?? '', context) : { file: null }),
        line: location ? Number(location[1]) : null,
        message: (warning[1] ?? '').trim(),
        context: '',
        raw: location ? `${line}\n${lines[index + 1] ?? ''}` : line,
      });
      continue;
    }
    const located = BIBTEX_LOCATION.exec(line);
    if (located) {
      // The excerpt BibTeX quotes follows on lines starting with ` : `.
      const excerpt: string[] = [];
      while ((lines[index + 1 + excerpt.length] ?? '').startsWith(' : ')) {
        excerpt.push(lines[index + 1 + excerpt.length] ?? '');
      }
      entries.push({
        level: 'error',
        source: 'bibtex',
        ...bibFile(located[2] ?? '', context),
        line: Number(located[1]),
        message: line.slice(0, located.index).trim(),
        context: excerpt.join('\n'),
        raw: [line, ...excerpt].join('\n'),
      });
      index += excerpt.length;
      continue;
    }
    const fatal = BIBTEX_FATAL.exec(line);
    if (fatal) {
      entries.push({
        level: 'error',
        source: 'bibtex',
        ...bibFile(fatal[1] ?? '', context),
        line: null,
        message: line.trim(),
        context: '',
        raw: line,
      });
    }
  }
  return entries;
}
