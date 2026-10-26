import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HealthResponse } from '../health.js';

export interface ProbeHandlers {
  /** Liveness: the process is running and its event loop responds. */
  live: () => HealthResponse | Promise<HealthResponse>;
  /** Readiness: the dependencies the service needs are reachable. */
  ready: () => Promise<HealthResponse>;
  /** Prometheus exposition, returned as `[contentType, body]`. */
  metrics: () => Promise<[string, string]>;
}

/**
 * Serves `/health/live`, `/health/ready` and `/metrics` for services that have
 * no HTTP framework of their own. Returns `null` for any other path so callers
 * can chain it in front of their own request handling.
 */
export function createProbeHandler(
  handlers: ProbeHandlers,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      return false;
    }
    const path = (req.url ?? '/').split('?')[0];
    switch (path) {
      case '/health/live':
        sendHealth(res, await handlers.live());
        return true;
      case '/health/ready':
        sendHealth(res, await handlers.ready());
        return true;
      case '/metrics': {
        const [contentType, body] = await handlers.metrics();
        res.writeHead(200, { 'content-type': contentType });
        res.end(body);
        return true;
      }
      default:
        return false;
    }
  };
}

/** Standalone HTTP server exposing only the probe endpoints. */
export function createProbeServer(handlers: ProbeHandlers): Server {
  const handle = createProbeHandler(handlers);
  return createServer((req, res) => {
    handle(req, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'NOT_FOUND', messageKey: 'errors.NOT_FOUND' } }));
        }
      })
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(
          JSON.stringify({
            error: { code: 'INTERNAL_ERROR', messageKey: 'errors.INTERNAL_ERROR' },
          }),
        );
      });
  });
}

function sendHealth(res: ServerResponse, body: HealthResponse): void {
  res.writeHead(body.status === 'ok' ? 200 : 503, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
