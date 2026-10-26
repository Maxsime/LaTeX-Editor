import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { failureReasons, processCompileJob } from './worker.js';

const validJob = {
  compileId: '0193f9f0-4d0a-7c3e-8f5a-1b2c3d4e5f60',
  projectId: '0193f9f0-4d0a-7c3e-8f5a-1b2c3d4e5f61',
  manifest: { 'main.tex': 'b'.repeat(64) },
  texmfManifest: {},
  mainFile: 'main.tex',
  engine: 'pdflatex',
  bibTool: 'biber',
  shellEscape: 'disabled',
  draft: false,
  haltOnError: true,
};

describe('processCompileJob', () => {
  it('rejects malformed jobs without retry', async () => {
    const result = processCompileJob({ data: { ...validJob, mainFile: '../../etc/passwd' } });
    await expect(result).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(result).rejects.toThrow(failureReasons.invalidJob);
  });

  it('fails valid jobs as not implemented until J3', async () => {
    await expect(processCompileJob({ data: validJob })).rejects.toThrow(
      failureReasons.notImplemented,
    );
  });
});
