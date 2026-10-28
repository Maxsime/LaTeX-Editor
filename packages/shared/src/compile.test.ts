import { describe, expect, it } from 'vitest';
import { compileRequest, isFinalCompileStatus } from './compile.js';
import { compileStatus } from './compile-job.js';

describe('compileRequest', () => {
  it('turns every option off by default', () => {
    expect(compileRequest.parse({})).toEqual({
      draft: false,
      haltOnError: false,
      clean: false,
      original: false,
    });
  });

  it('rejects options of the wrong type', () => {
    expect(compileRequest.safeParse({ draft: 'yes' }).success).toBe(false);
  });
});

describe('isFinalCompileStatus', () => {
  it('only leaves queued and running compilations open', () => {
    const open = compileStatus.options.filter((status) => !isFinalCompileStatus(status));
    expect(open).toEqual(['queued', 'running']);
  });
});
