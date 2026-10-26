import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { COMPILE_QUEUE, healthResponse } from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import { Queue, QueueEvents } from 'bullmq';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { type CompilerService, createCompilerService, failureReasons } from '../src/worker.js';

// Keep in sync with compose.yaml.
const VALKEY_IMAGE = 'valkey/valkey:8.1.10-alpine';
const dockerAvailable =
  Boolean(process.env.DOCKER_HOST) || existsSync('/var/run/docker.sock') || Boolean(process.env.CI);

describe.skipIf(!dockerAvailable)('compiler service', () => {
  let valkey: StartedTestContainer;
  let service: CompilerService;
  let queue: Queue;
  let events: QueueEvents;
  let base = '';

  beforeAll(async () => {
    valkey = await new GenericContainer(VALKEY_IMAGE)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    const config = readConfig({
      VALKEY_URL: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`,
    });
    service = createCompilerService(
      config,
      createLogger({ service: 'compiler', level: 'silent' }),
      'test',
    );
    await service.worker.waitUntilReady();
    await new Promise<void>((resolve) => service.probeServer.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(service.probeServer.address() as AddressInfo).port}`; // TCP listen yields AddressInfo
    const connection = { url: config.VALKEY_URL };
    queue = new Queue(COMPILE_QUEUE, { connection });
    events = new QueueEvents(COMPILE_QUEUE, { connection });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await events.close();
    await queue.close();
    await service.close();
    await valkey.stop();
  });

  it('is ready once connected to Valkey', async () => {
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(200);
    expect(healthResponse.parse(await response.json()).checks).toMatchObject({
      valkey: { status: 'ok' },
      worker: { status: 'ok' },
    });
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
  });

  it('consumes the compile queue and fails jobs without retrying', async () => {
    const job = await queue.add('compile', { not: 'a compile job' }, { attempts: 3 });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(failureReasons.invalidJob);
    const failed = await queue.getJob(job.id ?? '');
    expect(failed?.attemptsMade).toBe(1);
  });

  it('counts handled jobs in metrics', async () => {
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(
      /galley_compile_jobs_total\{outcome="failed",service="compiler"\} [1-9]/,
    );
  });
});
