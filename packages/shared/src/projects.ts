import * as z from 'zod/mini';
import { bibTool, engine, shellEscapeMode } from './compile-job.js';
import { fileId, importWarning } from './files.js';

export const projectRole = z.enum(['owner', 'editor', 'reviewer', 'reader']);
export type ProjectRole = z.infer<typeof projectRole>;

const roleRank: Record<ProjectRole, number> = { reader: 0, reviewer: 1, editor: 2, owner: 3 };

/** Tells whether `role` grants at least the rights of `required`. */
export function hasRole(role: ProjectRole, required: ProjectRole): boolean {
  return roleRank[role] >= roleRank[required];
}

export const projectName = z.string().check(
  z.minLength(1),
  z.maxLength(150),
  z.refine((name) => name.trim() === name, 'no leading or trailing spaces'),
);

export const tagColor = z.string().check(z.regex(/^#[0-9a-f]{6}$/));

export const tag = z.object({ id: z.uuid(), name: z.string(), color: tagColor });
export type Tag = z.infer<typeof tag>;

export const tagRequest = z.object({
  name: z.string().check(z.minLength(1), z.maxLength(50)),
  color: tagColor,
});

export const projectState = z.enum(['active', 'archived', 'trashed']);
export type ProjectState = z.infer<typeof projectState>;

export const projectSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  role: projectRole,
  owner: z.object({ id: z.uuid(), displayName: z.string() }),
  state: projectState,
  tagIds: z.array(z.uuid()),
  createdAt: z.string(),
  updatedAt: z.string(),
  trashedAt: z.nullable(z.string()),
});
export type ProjectSummary = z.infer<typeof projectSummary>;

export const projectDetails = z.object({
  ...projectSummary.shape,
  mainFileId: z.nullable(fileId),
  engine,
  bibTool,
  shellEscape: shellEscapeMode,
});
export type ProjectDetails = z.infer<typeof projectDetails>;

export const projectSort = z.enum(['updatedAt', 'createdAt', 'name']);

export const listProjectsQuery = z.object({
  state: z._default(projectState, 'active'),
  search: z.optional(z.string().check(z.maxLength(150))),
  tagId: z.optional(z.uuid()),
  sort: z._default(projectSort, 'updatedAt'),
  order: z._default(z.enum(['asc', 'desc']), 'desc'),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuery>;

export const projectTemplate = z.enum(['blank', 'article']);
export type ProjectTemplate = z.infer<typeof projectTemplate>;

export const createProjectRequest = z.object({
  name: projectName,
  template: z._default(projectTemplate, 'blank'),
});

export const updateProjectRequest = z.object({
  name: z.optional(projectName),
  mainFileId: z.optional(z.nullable(fileId)),
  engine: z.optional(engine),
  bibTool: z.optional(bibTool),
  shellEscape: z.optional(shellEscapeMode),
});
export type UpdateProjectRequest = z.input<typeof updateProjectRequest>;

export const importProjectResponse = z.object({
  project: projectSummary,
  warnings: z.array(importWarning),
});
export type ImportProjectResponse = z.infer<typeof importProjectResponse>;

/** Days a trashed project stays restorable (SPEC §3.1). */
export const TRASH_RETENTION_DAYS = 30;
