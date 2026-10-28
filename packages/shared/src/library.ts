import * as z from 'zod/mini';
import { engine } from './compile-job.js';
import { fileId, fileLink } from './files.js';
import { fileName } from './names.js';
import { projectName } from './projects.js';

// --- Duplication and copies ------------------------------------------------------

export const duplicateProjectRequest = z.object({ name: projectName });
export type DuplicateProjectRequest = z.infer<typeof duplicateProjectRequest>;

/** Most files copied from another project in one request. */
export const MAX_COPIED_FILES = 200;

/** Copies files or folders of another project into a folder of this one. */
export const copyFilesRequest = z.object({
  sourceProjectId: z.uuid(),
  fileIds: z.array(fileId).check(z.minLength(1), z.maxLength(MAX_COPIED_FILES)),
  targetFolderId: z.nullable(fileId),
});
export type CopyFilesRequest = z.infer<typeof copyFilesRequest>;

// --- Templates --------------------------------------------------------------------

export const templateVisibility = z.enum(['private', 'instance']);
export type TemplateVisibility = z.infer<typeof templateVisibility>;

const templateName = projectName;
const templateDescription = z.string().check(z.maxLength(500));

export const templateSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  visibility: templateVisibility,
  ownerName: z.string(),
  /** The template belongs to the person asking: they may rename or delete it. */
  mine: z.boolean(),
  files: z.number(),
  engine,
  createdAt: z.string(),
});
export type TemplateSummary = z.infer<typeof templateSummary>;

export const saveTemplateRequest = z.object({
  name: templateName,
  description: z._default(templateDescription, ''),
  /** Publishing for the whole instance is reserved to administrators. */
  visibility: z._default(templateVisibility, 'private'),
});
export type SaveTemplateRequest = z.infer<typeof saveTemplateRequest>;

export const updateTemplateRequest = z.object({
  name: z.optional(templateName),
  description: z.optional(templateDescription),
  visibility: z.optional(templateVisibility),
});
export type UpdateTemplateRequest = z.infer<typeof updateTemplateRequest>;

// --- Linked files -----------------------------------------------------------------

export const createLinkedFileRequest = z.object({
  parentId: z.nullable(fileId),
  name: fileName,
  link: fileLink,
});
export type CreateLinkedFileRequest = z.infer<typeof createLinkedFileRequest>;

// --- Personal texmf ---------------------------------------------------------------

/** The personal texmf tree, a project of type `texmf` created on first request. */
export const texmfResponse = z.object({ projectId: z.uuid() });
export type TexmfResponse = z.infer<typeof texmfResponse>;
