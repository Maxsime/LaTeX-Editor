import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_ERROR_QUIET_MS,
  handleProcessLifecycle,
  logConnectionErrors,
} from './lifecycle.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: pino(sink), lines };
}

describe('logConnectionErrors', () => {
  it('logs a repeated error once per quiet period', () => {
    const { logger, lines } = capture();
    const emitter = new EventEmitter();
    let time = 0;
    logConnectionErrors(logger, 'valkey', emitter, () => time);
    emitter.emit('error', new Error('ECONNREFUSED'));
    time += 1_000;
    emitter.emit('error', new Error('ECONNREFUSED'));
    emitter.emit('error', new Error('ETIMEDOUT'));
    time += CONNECTION_ERROR_QUIET_MS;
    emitter.emit('error', new Error('ECONNREFUSED'));
    expect(lines.map((line) => (line.err as { message: string }).message)).toEqual([
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ECONNREFUSED',
    ]);
    expect(lines[0]).toMatchObject({ connection: 'valkey', level: 40 });
  });
});

describe('handleProcessLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes once on SIGTERM, then exits 0', async () => {
    const { logger } = capture();
    const target = new EventEmitter();
    const exit = vi.fn<(code: number) => void>();
    const close = vi.fn(() => Promise.resolve());
    handleProcessLifecycle({ logger, close, exit, target });
    target.emit('SIGTERM', 'SIGTERM');
    target.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when close fails', async () => {
    const { logger } = capture();
    const target = new EventEmitter();
    const exit = vi.fn<(code: number) => void>();
    handleProcessLifecycle({
      logger,
      close: () => Promise.reject(new Error('stuck')),
      exit,
      target,
    });
    target.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  it('exits 1 when close outlasts the deadline', () => {
    vi.useFakeTimers();
    const { logger, lines } = capture();
    const target = new EventEmitter();
    const exit = vi.fn<(code: number) => void>();
    handleProcessLifecycle({
      logger,
      close: () => new Promise(() => undefined),
      exit,
      target,
      timeoutMs: 500,
    });
    target.emit('SIGTERM', 'SIGTERM');
    vi.advanceTimersByTime(499);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.at(-1)).toMatchObject({ msg: 'shutdown timed out' });
  });

  it('logs an unhandled rejection as fatal and exits 1', () => {
    const { logger, lines } = capture();
    const target = new EventEmitter();
    const exit = vi.fn<(code: number) => void>();
    handleProcessLifecycle({ logger, close: () => Promise.resolve(), exit, target });
    target.emit('unhandledRejection', new Error('lost'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.at(-1)).toMatchObject({ level: 60, msg: 'unhandled promise rejection' });
  });
});
