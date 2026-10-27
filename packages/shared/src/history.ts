import * as z from 'zod/mini';
import { projectPath } from './compile-job.js';

/** Why a snapshot was taken (SPEC §6.7). */
export const snapshotKind = z.enum(['auto', 'compile', 'named', 'restore', 'git']);
export type SnapshotKind = z.infer<typeof snapshotKind>;

/** Name of a version, given by a user. */
export const snapshotLabel = z.string().check(z.trim(), z.minLength(1), z.maxLength(100));

/** One entry of a project's history, newest first. */
export const snapshotSummary = z.object({
  id: z.uuid(),
  kind: snapshotKind,
  label: z.nullable(z.string()),
  createdAt: z.string(),
  /** Users who changed the project since the previous entry; deleted accounts are left out. */
  authors: z.array(z.object({ id: z.uuid(), displayName: z.string() })),
  fileCount: z.number(),
});
export type SnapshotSummary = z.infer<typeof snapshotSummary>;

export const historyResponse = z.object({
  snapshots: z.array(snapshotSummary),
  /** Pass as `before` to read older entries; null at the start of the history. */
  nextCursor: z.nullable(z.string()),
});
export type HistoryResponse = z.infer<typeof historyResponse>;

/** Body of `POST /api/projects/:id/history`: names the current state. */
export const createVersionRequest = z.object({ label: snapshotLabel });

/** Body of `PATCH /api/projects/:id/history/:snapshotId`. */
export const updateSnapshotRequest = z.object({ label: z.nullable(snapshotLabel) });

/** Files of a version: path and SHA-256 of the content. */
export const snapshotFilesResponse = z.object({
  files: z.array(z.object({ path: z.string(), hash: z.string() })),
  folders: z.array(z.string()),
});
export type SnapshotFilesResponse = z.infer<typeof snapshotFilesResponse>;

export const fileChangeStatus = z.enum(['added', 'removed', 'modified']);
export type FileChangeStatus = z.infer<typeof fileChangeStatus>;

/** Differences between two versions, or a version and the current state. */
export const compareResponse = z.object({
  changes: z.array(
    z.object({
      path: z.string(),
      status: fileChangeStatus,
      /** Hash on each side; null where the file does not exist. */
      from: z.nullable(z.string()),
      to: z.nullable(z.string()),
      /** Whether both sides can be shown as text. */
      text: z.boolean(),
    }),
  ),
});
export type CompareResponse = z.infer<typeof compareResponse>;

/** Body of `POST /api/projects/:id/history/:snapshotId/restore`; no path restores everything. */
export const restoreRequest = z.object({ path: z.optional(projectPath) });

/** Answer to a restore: the snapshot that records the restored state. */
export const restoreResponse = z.object({ snapshot: snapshotSummary });
export type RestoreResponse = z.infer<typeof restoreResponse>;

/** A personal access token as its owner sees it; the secret is only shown once. */
export const accessToken = z.object({
  id: z.uuid(),
  name: z.string(),
  hint: z.string(),
  createdAt: z.string(),
  expiresAt: z.nullable(z.string()),
  lastUsedAt: z.nullable(z.string()),
});
export type AccessToken = z.infer<typeof accessToken>;

export const accessTokensResponse = z.object({ tokens: z.array(accessToken) });
export type AccessTokensResponse = z.infer<typeof accessTokensResponse>;

export const createAccessTokenRequest = z.object({
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(100)),
  expiresInDays: z.optional(z.int().check(z.gte(1), z.lte(365))),
});

export const createdAccessToken = z.object({ token: z.string(), accessToken });
export type CreatedAccessToken = z.infer<typeof createdAccessToken>;

/** Prefix of personal access tokens, so that leaked ones are easy to recognise. */
export const ACCESS_TOKEN_PREFIX = 'glp_';
