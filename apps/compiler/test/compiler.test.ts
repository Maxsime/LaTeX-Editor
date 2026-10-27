import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  COMPILE_CANCEL_CHANNEL,
  COMPILE_QUEUE,
  compileCancelKey,
  type CompileJob,
  compileResult,
  healthResponse,
  TEXLIVE_VERSION_KEY,
} from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompileEnvironment, LocalCompileResult } from '../src/compile.js';
import { readConfig } from '../src/config.js';
import { projectDirs } from '../src/workdir.js';
import { type CompilerService, createCompilerService, failureReasons } from '../src/worker.js';

// Keep in sync with compose.yaml.
const VALKEY_IMAGE = 'valkey/valkey:8.1.10-alpine';
const dockerAvailable =
  Boolean(process.env.DOCKER_HOST) || existsSync('/var/run/docker.sock') || Boolean(process.env.CI);

const PROJECT = '0193f9f0-4d0a-7c3e-8f5a-1b2c3d4e5f61';
let sequence = 0;
function job(overrides: Partial<CompileJob> = {}): CompileJob {
  sequence += 1;
  return {
    compileId: `0193f9f0-4d0a-7c3e-8f5a-${sequence.toString(16).padStart(12, '0')}`,
    projectId: PROJECT,
    manifest: { 'main.tex': 'b'.repeat(64) },
    texmfManifest: {},
    mainFile: 'main.tex',
    engine: 'pdflatex',
    bibTool: 'biber',
    shellEscape: 'restricted',
    draft: false,
    haltOnError: false,
    clean: false,
    ...overrides,
  };
}

/**
 * Stands in for TeX: waits until released or cancelled, writes a PDF in the
 * project's output folder, and records how many compilations overlap.
 */
class FakeCompiler {
  active = 0;
  maxActive = 0;
  private readonly releases = new Map<string, () => void>();
  started: string[] = [];

  release(compileId: string): void {
    this.releases.get(compileId)?.();
  }

  compile = async (
    data: CompileJob,
    env: CompileEnvironment,
    signal: AbortSignal,
  ): Promise<LocalCompileResult> => {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    // Ready to be released or cancelled before the test can see the job as started.
    const ended = new Promise<boolean>((resolve) => {
      if (signal.aborted) resolve(true);
      signal.addEventListener('abort', () => {
        resolve(true);
      });
      this.releases.set(data.compileId, () => {
        resolve(false);
      });
    });
    this.started.push(data.compileId);
    const dirs = projectDirs(env.workRoot, data.projectId);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dirs.out, { recursive: true });
    await writeFile(join(dirs.out, 'main.pdf'), '%PDF-1.5 fake');
    const cancelled = await ended;
    this.active -= 1;
    return {
      result: {
        outcome: cancelled ? 'cancelled' : 'success',
        durationMs: 5,
        pdf: cancelled ? null : 'main.pdf',
        pages: cancelled ? null : 1,
        diagnostics: [],
        truncated: false,
        texlive: env.texlive,
        shellEscapeDowngraded: false,
      },
      dirs,
      publishable: [{ name: 'main.pdf', size: 13 }],
      run: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled,
        outputExceeded: false,
        console: '',
        durationMs: 5,
      },
    };
  };
}

describe.skipIf(!dockerAvailable)('compiler service', () => {
  let valkey: StartedTestContainer;
  let service: CompilerService;
  let queue: Queue;
  let events: QueueEvents;
  let redis: Redis;
  let base = '';
  const fake = new FakeCompiler();
  const published: { compileId: string; name: string; body: string }[] = [];

  beforeAll(async () => {
    valkey = await new GenericContainer(VALKEY_IMAGE)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    const config = readConfig({
      VALKEY_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
      S3_ENDPOINT: 'http://storage.invalid:8333',
      S3_ACCESS_KEY_ID: 'galley',
      S3_SECRET_ACCESS_KEY: 'unused-in-this-test',
      S3_BUCKET: 'galley',
      COMPILER_WORK_DIR: await mkdtemp(join(tmpdir(), 'galley-work-')),
      COMPILER_CONCURRENCY: '4',
    });
    service = createCompilerService(
      config,
      createLogger({ service: 'compiler', level: 'silent' }),
      'test',
      {
        texlive: { dir: '/usr/local/texlive/2026', release: 'TeX Live 2026' },
        fetchBlob: () => Promise.resolve(Readable.from([])),
        publish: async (compileId, name, body) => {
          const chunks: Buffer[] = [];
          for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
          published.push({ compileId, name, body: Buffer.concat(chunks).toString('utf8') });
        },
        compile: fake.compile,
      },
    );
    await service.worker.waitUntilReady();
    await new Promise<void>((resolve) => service.probeServer.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((service.probeServer.address() as AddressInfo).port)}`; // TCP listen yields AddressInfo
    const connection = { url: config.VALKEY_URL };
    queue = new Queue(COMPILE_QUEUE, { connection });
    events = new QueueEvents(COMPILE_QUEUE, { connection });
    redis = new Redis(config.VALKEY_URL);
    await events.waitUntilReady();
  });

  afterAll(async () => {
    redis.disconnect();
    await events.close();
    await queue.close();
    await service.close();
    await valkey.stop();
  });

  const waitForStart = async (compileId: string) => {
    for (let attempt = 0; attempt < 100 && !fake.started.includes(compileId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fake.started).toContain(compileId);
  };

  it('reports ready once Valkey and the worker are up, and the TeX Live release', async () => {
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(200);
    expect(healthResponse.parse(await response.json()).checks).toMatchObject({
      valkey: { status: 'ok' },
      worker: { status: 'ok' },
    });
    expect(await redis.get(TEXLIVE_VERSION_KEY)).toBe('TeX Live 2026');
  });

  it('compiles a job, publishes its outputs and returns a valid result', async () => {
    const data = job();
    const queued = await queue.add('compile', data, { jobId: data.compileId });
    await waitForStart(data.compileId);
    fake.release(data.compileId);
    const result = compileResult.parse(await queued.waitUntilFinished(events, 10_000));
    expect(result).toMatchObject({
      outcome: 'success',
      pdf: 'main.pdf',
      outputs: [{ name: 'main.pdf', size: 13 }],
    });
    expect(published).toContainEqual({
      compileId: data.compileId,
      name: 'main.pdf',
      body: '%PDF-1.5 fake',
    });
  });

  it('never runs two compilations of the same project at once', async () => {
    fake.maxActive = 0;
    const first = job();
    const second = job();
    const firstJob = await queue.add('compile', first, { jobId: first.compileId });
    const secondJob = await queue.add('compile', second, { jobId: second.compileId });
    await waitForStart(first.compileId);
    // The second job waits for the lock even though the worker has free slots.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fake.started).not.toContain(second.compileId);
    fake.release(first.compileId);
    await firstJob.waitUntilFinished(events, 10_000);
    await waitForStart(second.compileId);
    fake.release(second.compileId);
    await secondJob.waitUntilFinished(events, 10_000);
    expect(fake.maxActive).toBe(1);
  });

  it('stops a running compilation when the API publishes its cancellation', async () => {
    const data = job();
    const queued = await queue.add('compile', data, { jobId: data.compileId });
    await waitForStart(data.compileId);
    await redis.publish(COMPILE_CANCEL_CHANNEL, data.compileId);
    const result = compileResult.parse(await queued.waitUntilFinished(events, 10_000));
    expect(result).toMatchObject({ outcome: 'cancelled', outputs: [] });
  });

  it('honours a cancellation recorded before the job started', async () => {
    const data = job();
    await redis.set(compileCancelKey(data.compileId), '1', 'EX', 60);
    const queued = await queue.add('compile', data, { jobId: data.compileId });
    const result = compileResult.parse(await queued.waitUntilFinished(events, 10_000));
    expect(result.outcome).toBe('cancelled');
  });

  it('fails malformed jobs without retrying', async () => {
    const queued = await queue.add('compile', { not: 'a compile job' }, { attempts: 3 });
    await expect(queued.waitUntilFinished(events, 10_000)).rejects.toThrow(
      failureReasons.invalidJob,
    );
    expect((await queue.getJob(queued.id ?? ''))?.attemptsMade).toBe(1);
  });

  it('counts handled jobs in metrics', async () => {
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(
      /galley_compile_jobs_total\{outcome="success",service="compiler"\} [1-9]/,
    );
    expect(metrics).toMatch(
      /galley_compile_jobs_total\{outcome="cancelled",service="compiler"\} [1-9]/,
    );
  });
});
