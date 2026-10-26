import { describe, expect, it } from 'vitest';
import { createFolderRequest, updateFileRequest } from './files.js';
import {
  createProjectRequest,
  hasRole,
  listProjectsQuery,
  projectName,
  tagRequest,
  updateProjectRequest,
} from './projects.js';

describe('hasRole', () => {
  it('orders roles from reader to owner', () => {
    expect(hasRole('owner', 'editor')).toBe(true);
    expect(hasRole('editor', 'editor')).toBe(true);
    expect(hasRole('reviewer', 'editor')).toBe(false);
    expect(hasRole('reader', 'reviewer')).toBe(false);
  });
});

describe('project schemas', () => {
  it('applies list defaults', () => {
    expect(listProjectsQuery.parse({})).toEqual({
      state: 'active',
      sort: 'updatedAt',
      order: 'desc',
    });
  });

  it('defaults to the blank template', () => {
    expect(createProjectRequest.parse({ name: 'Rapport' })).toEqual({
      name: 'Rapport',
      template: 'blank',
    });
  });

  it.each(['', ' padded', 'x'.repeat(151)])('refuses the project name %j', (name) => {
    expect(projectName.safeParse(name).success).toBe(false);
  });

  it('accepts a partial project update', () => {
    expect(updateProjectRequest.safeParse({ engine: 'lualatex' }).success).toBe(true);
    expect(updateProjectRequest.safeParse({ engine: 'tex' }).success).toBe(false);
  });

  it('requires a lowercase hex tag colour', () => {
    expect(tagRequest.safeParse({ name: 'Stage', color: '#a1b2c3' }).success).toBe(true);
    expect(tagRequest.safeParse({ name: 'Stage', color: 'red' }).success).toBe(false);
  });
});

describe('file schemas', () => {
  it('validates folder names', () => {
    expect(createFolderRequest.safeParse({ parentId: null, name: 'figures' }).success).toBe(true);
    expect(createFolderRequest.safeParse({ parentId: null, name: '../x' }).success).toBe(false);
  });

  it('accepts a move to the root', () => {
    expect(updateFileRequest.parse({ parentId: null })).toEqual({ parentId: null });
  });
});
