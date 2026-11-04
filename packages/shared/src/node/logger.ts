import { type DestinationStream, pino, type Logger, type LoggerOptions } from 'pino';

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

/** Paths whose next segment is a bearer secret: share link tokens. */
const SECRET_SEGMENTS = /(\/(?:api\/links|join)\/)[^/?#]+/g;

/**
 * A URL fit for a log line: query values (OAuth codes and states, tokens a
 * client put there) and share link tokens are replaced, names are kept.
 */
export function loggableUrl(url: string): string {
  const query = url.indexOf('?');
  const path = (query === -1 ? url : url.slice(0, query)).replace(SECRET_SEGMENTS, '$1[redacted]');
  if (query === -1) return path;
  const names = url
    .slice(query + 1)
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => `${pair.split('=')[0] ?? ''}=[redacted]`);
  return `${path}?${names.join('&')}`;
}

interface LoggedRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number } | null;
}

/** Fastify's request serializer, with the URL passed through {@link loggableUrl}. */
function serializeRequest(request: LoggedRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url === undefined ? undefined : loggableUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/** Query parameters as Drizzle writes them in its error messages, up to the stack frames. */
const QUERY_PARAMS = /\nparams: [\s\S]*?(?=\n\s+at |$)/g;
/** Properties of database errors that hold the parameters of the query. */
const PARAMETER_KEYS = new Set(['params', 'parameters']);

function scrubError(value: unknown, depth: number): unknown {
  if (typeof value !== 'object' || value === null || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => scrubError(item, depth + 1));
  const scrubbed: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (PARAMETER_KEYS.has(key)) {
      scrubbed[key] = '[redacted]';
    } else if (typeof field === 'string' && (key === 'message' || key === 'stack')) {
      scrubbed[key] = field.replace(QUERY_PARAMS, '\nparams: [redacted]');
    } else {
      scrubbed[key] = scrubError(field, depth + 1);
    }
  }
  return scrubbed;
}

/**
 * pino's error serializer, without the parameters of failed queries: Drizzle
 * puts them in the message, the stack and a property, and they hold whatever
 * the query wrote (e-mail addresses, file names, token digests, text).
 */
export function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return scrubError(pino.stdSerializers.err(error), 0);
}

export interface LoggerSettings {
  service: string;
  level: LoggerOptions['level'];
  /** Where lines go; stdout by default. Tests pass a stream to read the logs back. */
  destination?: DestinationStream;
}

/** Creates the structured logger shared by all server-side services. */
export function createLogger({ service, level, destination }: LoggerSettings): Logger {
  const options: LoggerOptions = {
    level: level ?? 'info',
    base: { service },
    redact: { paths: redactedPaths, censor: '[redacted]' },
    // Fastify keeps these over its own serializers.
    serializers: { err: serializeError, req: serializeRequest },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export type { Logger } from 'pino';
