import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Paths removed from every log line. Document content, API keys and tokens must
 * never be logged (CLAUDE.md); this list is a safety net, not a licence to log
 * whole request bodies.
 */
export const redactedPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.content',
];

export interface LoggerSettings {
  service: string;
  level: LoggerOptions['level'];
}

/** Creates the structured logger shared by all server-side services. */
export function createLogger({ service, level }: LoggerSettings): Logger {
  return pino({
    level: level ?? 'info',
    base: { service },
    redact: { paths: redactedPaths, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger } from 'pino';
