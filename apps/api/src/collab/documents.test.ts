import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '@galley/db';
import { COLLAB_TOKEN_HEADER } from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiConfig } from '../config.js';
import { stateToText } from '../yjs/text.js';
import { createDocumentGateway } from './documents.js';

const TOKEN = 'k'.repeat(32);
const FILE = '0b8e4c1e-8f0a-4d2b-9c51-3f1f8f0f6a10';
const logger = createLogger({ service: 'api', level: 'silent' });

interface Call {
  path: string;
  token: string | undefined;
  body: string;
}

/** Records direct state writes made by the fallback path. */
function fakeDatabase(): { database: Database; written: { fileId: string; text: string }[] } {
  const written: { fileId: string; text: string }[] = [];
  const db = {
    insert: () => ({
      values: (row: { fileId: string; state: Uint8Array }) => ({
        onConflictDoUpdate: () => {
          written.push({ fileId: row.fileId, text: stateToText(row.state) });
          return Promise.resolve();
        },
      }),
    }),
  };
  // Only the insert chain used by the fallback is implemented.
  return { database: { db } as unknown as Database, written };
}

function config(url: string | undefined): ApiConfig {
  // The gateway reads only the two collab variables.
  const partial: Partial<ApiConfig> = { COLLAB_INTERNAL_TOKEN: TOKEN };
  if (url !== undefined) partial.COLLAB_INTERNAL_URL = url;
  return partial as ApiConfig;
}

let server: Server | undefined;

async function fakeCollab(
  status: (path: string) => number,
): Promise<{ url: string; calls: Call[] }> {
  const calls: Call[] = [];
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      const header = request.headers[COLLAB_TOKEN_HEADER];
      calls.push({ path, token: typeof header === 'string' ? header : undefined, body });
      response.writeHead(status(path)).end();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, calls };
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server) {
      server.close(() => {
        resolve();
      });
    } else resolve();
  });
  server = undefined;
});

describe('document gateway', () => {
  it('writes directly when collab is not configured', async () => {
    const { database, written } = fakeDatabase();
    const gateway = createDocumentGateway(config(undefined), database, logger);
    await gateway.flushProject(FILE);
    await gateway.apply({ replaced: [{ fileId: FILE, content: 'new' }], closed: [FILE] });
    expect(written).toEqual([{ fileId: FILE, text: 'new' }]);
  });

  it('goes through collab with the shared token', async () => {
    const { url, calls } = await fakeCollab(() => 204);
    const { database, written } = fakeDatabase();
    const gateway = createDocumentGateway(config(url), database, logger);
    await gateway.flushProject(FILE);
    await gateway.apply({ replaced: [{ fileId: FILE, content: 'é' }], closed: [FILE] });
    expect(calls).toEqual([
      { path: `/internal/projects/${FILE}/flush`, token: TOKEN, body: '' },
      { path: `/internal/documents/${FILE}/close`, token: TOKEN, body: '' },
      { path: `/internal/documents/${FILE}/replace`, token: TOKEN, body: '{"content":"é"}' },
    ]);
    expect(written).toEqual([]);
  });

  it('ignores files deleted in the meantime', async () => {
    const { url } = await fakeCollab(() => 404);
    const { database, written } = fakeDatabase();
    const gateway = createDocumentGateway(config(url), database, logger);
    await gateway.apply({ replaced: [{ fileId: FILE, content: 'x' }], closed: [] });
    expect(written).toEqual([]);
  });

  it('falls back to direct writes when collab is down', async () => {
    const { database, written } = fakeDatabase();
    const gateway = createDocumentGateway(config('http://127.0.0.1:1'), database, logger);
    await gateway.flushProject(FILE);
    await gateway.apply({ replaced: [{ fileId: FILE, content: 'offline' }], closed: [FILE] });
    expect(written).toEqual([{ fileId: FILE, text: 'offline' }]);
  });
});
