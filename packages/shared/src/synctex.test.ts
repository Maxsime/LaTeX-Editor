import { describe, expect, it } from 'vitest';
import {
  projectPathToSynctexInput,
  synctexEditQuery,
  synctexInputToProjectPath,
  synctexJob,
} from './synctex.js';

describe('synctexInputToProjectPath', () => {
  it('normalises the paths TeX records inside the sandbox', () => {
    expect(synctexInputToProjectPath('/project/./main.tex')).toBe('main.tex');
    expect(synctexInputToProjectPath('/project/sub/./chapters/one.tex')).toBe(
      'sub/chapters/one.tex',
    );
    expect(synctexInputToProjectPath('/project/sub/../two.tex')).toBe('two.tex');
  });

  it('rejects paths outside the project', () => {
    expect(synctexInputToProjectPath('/usr/local/texlive/2026/tex/latex/base/article.cls')).toBe(
      null,
    );
    expect(synctexInputToProjectPath('/out/main.aux')).toBe(null);
    expect(synctexInputToProjectPath('/project/../etc/passwd')).toBe(null);
    expect(synctexInputToProjectPath('/project/./')).toBe(null);
  });

  it('round-trips with projectPathToSynctexInput', () => {
    expect(synctexInputToProjectPath(projectPathToSynctexInput('a/b.tex'))).toBe('a/b.tex');
  });
});

describe('synctexJob', () => {
  const target = {
    compileId: '0193f9f0-4d0a-7c3e-8f5a-1b2c3d4e5f60',
    synctexFile: 'main.synctex.gz',
  };

  it('accepts edit and view queries', () => {
    expect(
      synctexJob.safeParse({ kind: 'edit', ...target, page: 2, x: 10.5, y: 300 }).success,
    ).toBe(true);
    expect(
      synctexJob.safeParse({ kind: 'view', ...target, file: 'ch/a.tex', line: 3, column: 0 })
        .success,
    ).toBe(true);
  });

  it('rejects paths leaving the project and files that are not SyncTeX data', () => {
    const view = { kind: 'view', ...target, line: 1, column: 0 };
    expect(synctexJob.safeParse({ ...view, file: '../x.tex' }).success).toBe(false);
    expect(synctexJob.safeParse({ ...view, file: 'a.tex', synctexFile: 'main.pdf' }).success).toBe(
      false,
    );
    expect(synctexJob.safeParse({ kind: 'edit', ...target, page: 0, x: 1, y: 1 }).success).toBe(
      false,
    );
  });
});

describe('synctexEditQuery', () => {
  it('coerces query strings', () => {
    expect(synctexEditQuery.parse({ page: '3', x: '12.5', y: '40' })).toEqual({
      page: 3,
      x: 12.5,
      y: 40,
    });
    expect(synctexEditQuery.safeParse({ page: '1.5', x: '1', y: '1' }).success).toBe(false);
  });
});
