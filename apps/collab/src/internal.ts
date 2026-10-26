import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { COLLAB_TOKEN_HEADER, MAX_TEXT_BYTES, replaceDocumentRequest } from '@galley/shared';

/** Operations the API may request on documents it does not hold. */
export interface InternalOperations {
  /** Persists the loaded documents of a project now. */
  flushProject(projectId: string): Promise<void>;
  /** Replaces a file's text through a server-side connection; `false` if the file is gone. */
  replaceDocument(fileId: string, content: string): Promise<boolean>;
  /** Disconnects everyone from a file's document and drops it without writing. */
  closeDocument(fileId: string): Promise<void>;
}

// JSON escaping can grow text several times over (control characters become \uXXXX).
const MAX_BODY_BYTES = 6 * MAX_TEXT_BYTES;

const ROUTE = /^\/internal\/(projects|documents)\/([0-9a-f-]{36})\/(flush|replace|close)$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function send(response: ServerResponse, status: number, body?: object): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function tokenMatches(received: string | string[] | undefined, expected: string): boolean {
  if (typeof received !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    // Node yields Buffers for a request without an encoding set.
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'VALIDATION');
  }
}

/**
 * Serves the internal routes used by the API. They live on collab's own port,
 * which the reverse proxy only reaches for WebSocket upgrades, and are guarded
 * by a shared token in addition.
 *
 * @returns `false` when the request is not an internal route.
 */
export async function handleInternalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  operations: InternalOperations,
): Promise<boolean> {
  const path = new URL(request.url ?? '/', 'http://collab').pathname;
  if (!path.startsWith('/internal/')) return false;
  try {
    if (!tokenMatches(request.headers[COLLAB_TOKEN_HEADER], token)) {
      throw new HttpError(401, 'UNAUTHENTICATED');
    }
    const match = ROUTE.exec(path);
    if (match === null || request.method !== 'POST') throw new HttpError(404, 'NOT_FOUND');
    const [, scope, id = '', action] = match;
    if (scope === 'projects' && action === 'flush') {
      await operations.flushProject(id);
    } else if (scope === 'documents' && action === 'replace') {
      const body = replaceDocumentRequest.safeParse(await readJson(request));
      if (!body.success) throw new HttpError(400, 'VALIDATION');
      if (!(await operations.replaceDocument(id, body.data.content))) {
        throw new HttpError(404, 'NOT_FOUND');
      }
    } else if (scope === 'documents' && action === 'close') {
      await operations.closeDocument(id);
    } else {
      throw new HttpError(404, 'NOT_FOUND');
    }
    send(response, 204);
  } catch (error) {
    if (error instanceof HttpError) {
      send(response, error.status, { error: { code: error.code } });
    } else {
      throw error;
    }
  }
  return true;
}
