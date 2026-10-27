import { describe, expect, it } from 'vitest';
import {
  blobKey,
  compileJob,
  compileLockKey,
  compileOutputKey,
  compileResult,
  projectPath,
} from './compile-job.js';

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

  it('accepts a well-formed job and defaults clean to false', () => {
    expect(compileJob.parse(job)).toEqual({ ...job, clean: false, chktexDisabled: [] });
  });

  it('rejects traversal in manifest keys and bad digests', () => {
    expect(compileJob.safeParse({ ...job, manifest: { '../x.tex': digest } }).success).toBe(false);
    expect(compileJob.safeParse({ ...job, manifest: { 'main.tex': 'abc' } }).success).toBe(false);
    expect(compileJob.safeParse({ ...job, engine: 'context' }).success).toBe(false);
  });
});

describe('compile keys and results', () => {
  it('names objects and locks', () => {
    expect(blobKey(digest)).toBe(`blobs/${digest}`);
    expect(compileOutputKey('c', 'main.pdf')).toBe('compiles/c/main.pdf');
    expect(compileLockKey('p')).toBe('compile:lock:p');
  });

  it('validates a worker result', () => {
    const result = {
      outcome: 'failure',
      durationMs: 1200,
      pdf: null,
      pages: null,
      diagnostics: [
        {
          level: 'error',
          source: 'tex',
          file: 'main.tex',
          line: 3,
          message: 'Undefined control sequence.',
          context: 'l.3 \\oops',
        },
      ],
      truncated: false,
      outputs: [{ name: 'main.log', size: 10 }],
      texlive: 'TeX Live 2026',
      shellEscapeDowngraded: false,
    };
    expect(compileResult.parse(result)).toEqual({ ...result, lint: [], wordCount: null });
    expect(compileResult.safeParse({ ...result, outcome: 'queued' }).success).toBe(false);
  });
});
