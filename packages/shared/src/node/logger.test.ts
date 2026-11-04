import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createLogger, loggableUrl, redactedPaths, serializeError } from './logger.js';

describe('logger', () => {
  it('redacts credentials and document content', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ redact: { paths: redactedPaths, censor: '[redacted]' } }, sink);
    logger.info({
      req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1' } },
      user: { password: 'pw', token: 't', apiKey: 'k' },
      file: { content: '\\documentclass{article}' },
    });
    const line = lines.join('');
    for (const secret of ['Bearer abc', 'sid=1', '"pw"', '"t"', '"k"', 'documentclass']) {
      expect(line).not.toContain(secret);
    }
  });

  it('tags log lines with the service name', () => {
    const logger = createLogger({ service: 'api', level: 'silent' });
    expect(logger.bindings()).toMatchObject({ service: 'api' });
    expect(logger.level).toBe('silent');
  });

  it('keeps secrets out of logged URLs', () => {
    expect(loggableUrl('/api/projects/42/files')).toBe('/api/projects/42/files');
    expect(loggableUrl('/api/links/abc123/join')).toBe('/api/links/[redacted]/join');
    expect(loggableUrl('/join/abc123')).toBe('/join/[redacted]');
    expect(loggableUrl('/api/auth/oidc/callback?code=c&state=s')).toBe(
      '/api/auth/oidc/callback?code=[redacted]&state=[redacted]',
    );
    expect(loggableUrl('/git/p/info/refs?service')).toBe('/git/p/info/refs?service=[redacted]');
  });

  it('serializes errors without the parameters of failed queries', () => {
    const cause = new Error('connection reset');
    const error = Object.assign(new Error('Failed query: select $1\nparams: hunter2,line\nbreak'), {
      params: ['hunter2'],
      cause,
    });
    const serialized = JSON.stringify(serializeError(error));
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('break');
    expect(serialized).toContain('Failed query: select $1');
    expect(serialized).toContain('connection reset');
    expect(serializeError('not an error')).toBe('not an error');
  });
});
