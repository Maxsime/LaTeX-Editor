/** Severity of a log entry. `badbox` covers overfull and underfull boxes. */
export type LogLevel = 'error' | 'warning' | 'badbox';

/** Tool whose output produced the entry. */
export type LogSource = 'tex' | 'biber' | 'bibtex' | 'latexmk';

/** One message extracted from a log. */
export interface LogEntry {
  level: LogLevel;
  source: LogSource;
  /** Project-relative path, or null when the message concerns no project file. */
  file: string | null;
  /** File outside the project the message points at (class, package), as printed. */
  externalFile?: string;
  /** 1-based line, when the log gives one. */
  line: number | null;
  /** Message on one line, without its `!` or `file:line:` prefix. */
  message: string;
  /** Source excerpt TeX printed with an error (`l.12 ...` and its continuation). */
  context: string;
  /** Text of the argument TeX ran away with, used to locate the missing brace. */
  runaway?: string;
  /** Log lines the entry was read from. */
  raw: string;
}
