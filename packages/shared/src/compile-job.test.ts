import { describe, expect, it } from 'vitest';
import { compileJob, projectPath } from './compile-job.js';

const digest = 'a'.repeat(64);

describe('projectPath', () => {
  it.each(['main.tex', 'chapters/intro.tex', 'figures/a b.png', '.latexmkrc'])(
    'accepts %s',
    (path) => {
      expect(projectPath.safeParse(path).success).toBe(true);
    },
  );

  it.each([
    '',
    '/etc/passwd',
    '../secret.tex',
    'a/../../b',
    'a/./b',
    'a//b',
    'a/',
    'C:\\x',
    'a\0b',
  ])('rejects %j', (path) => {
    expect(projectPath.safeParse(path).success).toBe(false);
  });
});

describe('compileJob', () => {
  const job = {
    compileId: '0193f9f0-4d0a-7c3e-8f5a-1b2c3d4e5f60',
    projectId: '0193f9f0-4d0a-7c3e-8f5a-1b2c3d4e5f61',
    manifest: { 'main.tex': digest },
    texmfManifest: {},
    mainFile: 'main.tex',
    engine: 'pdflatex',
    bibTool: 'biber',
    shellEscape: 'restricted',
    draft: false,
    haltOnError: false,
  };

  it('accepts a well-formed job', () => {
    expect(compileJob.parse(job)).toEqual(job);
  });

  it('rejects traversal in manifest keys and bad digests', () => {
    expect(compileJob.safeParse({ ...job, manifest: { '../x.tex': digest } }).success).toBe(false);
    expect(compileJob.safeParse({ ...job, manifest: { 'main.tex': 'abc' } }).success).toBe(false);
    expect(compileJob.safeParse({ ...job, engine: 'context' }).success).toBe(false);
  });
});
