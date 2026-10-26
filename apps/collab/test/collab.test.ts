import { existsSync } from 'node:fs';
import { healthResponse } from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { Server } from '@hocuspocus/server';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabServer, MAX_MESSAGE_BYTES } from '../src/collab.js';
import { readConfig } from '../src/config.js';

// Keep in sync with compose.yaml.
const VALKEY_IMAGE = 'valkey/valkey:8.1.10-alpine';
const dockerAvailable =
  Boolean(process.env.DOCKER_HOST) || existsSync('/var/run/docker.sock') || Boolean(process.env.CI);

describe.skipIf(!dockerAvailable)('collab server', () => {
  let valkey: StartedTestContainer;
  let redis: Redis;
  let server: Server;
  let base = '';

  beforeAll(async () => {
    valkey = await new GenericContainer(VALKEY_IMAGE)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    const config = readConfig({
      VALKEY_URL: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`,
    });
    redis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1 });
    server = createCollabServer({
      config,
      logger: createLogger({ service: 'collab', level: 'silent' }),
      version: 'test',
      redis,
    });
    // listen(0) is ignored by Hocuspocus, so request an ephemeral port through the configuration.
    server.configuration.port = 0;
    await server.listen();
    base = `127.0.0.1:${server.address.port}`;
  });

  afterAll(async () => {
    await server.destroy();
    redis.disconnect();
    await valkey.stop();
  });

  it('serves liveness and readiness', async () => {
    const live = await fetch(`http://${base}/health/live`);
    expect(live.status).toBe(200);
    expect(healthResponse.parse(await live.json()).service).toBe('collab');

    const ready = await fetch(`http://${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(healthResponse.parse(await ready.json()).checks?.valkey?.status).toBe('ok');
  });

  it('exposes metrics and answers 404 elsewhere', async () => {
    const metrics = await (await fetch(`http://${base}/metrics`)).text();
    expect(metrics).toContain('galley_collab_connections');
    expect((await fetch(`http://${base}/`)).status).toBe(404);
  });

  it('refuses every WebSocket authentication until access control exists', async () => {
    const reason = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('no authentication response'));
      }, 10_000);
      const provider = new HocuspocusProvider({
        url: `ws://${base}`,
        name: 'file:00000000-0000-0000-0000-000000000000',
        document: new Y.Doc(),
        token: 'forged-token',
        onAuthenticationFailed: ({ reason: failure }) => {
          clearTimeout(timer);
          provider.destroy();
          resolve(failure);
        },
        onSynced: () => {
          clearTimeout(timer);
          provider.destroy();
          reject(new Error('document synced without access control'));
        },
      });
    });
    expect(reason).toBeTruthy();
  });

  it('closes connections that send oversized frames', async () => {
    const code = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://${base}`);
      const timer = setTimeout(() => {
        reject(new Error('connection stayed open'));
      }, 10_000);
      socket.addEventListener('open', () => {
        socket.send(new Uint8Array(MAX_MESSAGE_BYTES + 1));
      });
      socket.addEventListener('close', (event) => {
        clearTimeout(timer);
        resolve(event.code);
      });
    });
    // 1009: message too big.
    expect(code).toBe(1009);
  });
});
