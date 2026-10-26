import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createLogger, redactedPaths } from './logger.js';

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
});
