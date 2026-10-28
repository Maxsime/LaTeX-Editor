import * as z from 'zod/mini';
import { fileName } from './names.js';

export const fileKind = z.enum(['folder', 'text', 'binary']);
export type FileKind = z.infer<typeof fileKind>;

export const fileId = z.uuid();

/** Longest URL a file may be linked to. */
export const MAX_LINK_URL_LENGTH = 2000;

/** Where a linked file comes from (SPEC §3.1). */
export const fileLink = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: z.url({ protocol: /^https?$/ }).check(z.maxLength(MAX_LINK_URL_LENGTH)),
  }),
  z.object({ kind: z.literal('project'), projectId: z.uuid(), fileId }),
]);
export type FileLink = z.infer<typeof fileLink>;

/** One node of a project tree as returned by the API; the client rebuilds the hierarchy. */
export const treeNode = z.object({
  id: fileId,
  parentId: z.nullable(fileId),
  name: z.string(),
  kind: fileKind,
  /** Bytes; `null` for folders. */
  size: z.nullable(z.number()),
  updatedAt: z.string(),
  /** Set for linked files, which are read-only and refreshed on request. */
  link: z.optional(
    z.object({
      source: fileLink,
      /** Name of the source: its URL, or the project and file it comes from. */
      label: z.string(),
      refreshedAt: z.nullable(z.string()),
    }),
  ),
});
export type TreeNode = z.infer<typeof treeNode>;

export const projectTree = z.object({
  mainFileId: z.nullable(fileId),
  nodes: z.array(treeNode),
});
export type ProjectTree = z.infer<typeof projectTree>;

export const createFolderRequest = z.object({
  parentId: z.nullable(fileId),
  name: fileName,
});
export type CreateFolderRequest = z.infer<typeof createFolderRequest>;

/** Rename, move, or both. */
export const updateFileRequest = z.object({
  name: z.optional(fileName),
  parentId: z.optional(z.nullable(fileId)),
});
export type UpdateFileRequest = z.infer<typeof updateFileRequest>;

/** Non-blocking remarks produced while importing files. */
export const importWarning = z.object({
  code: z.enum(['NOT_UTF8_TEXT', 'CASE_CONFLICT', 'IGNORED_ENTRY']),
  path: z.string(),
});
export type ImportWarning = z.infer<typeof importWarning>;

export const uploadResponse = z.object({
  /** Written files, plus the folders created on the way. */
  nodes: z.array(treeNode),
  warnings: z.array(importWarning),
});
export type UploadResponse = z.infer<typeof uploadResponse>;

/** Text files above this size are stored as binaries: the editor cannot handle them well. */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/** Per-file upload limit, also enforced by the multipart parser. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
