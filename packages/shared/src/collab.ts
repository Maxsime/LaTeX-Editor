import * as z from 'zod/mini';
import { compileStatus } from './compile-job.js';
import { projectMessage } from './review.js';

/** Name of the shared text holding a file's content, fixed for the whole application. */
export const TEXT_KEY = 'content';

/**
 * Close reason sent to a client whose update was refused (a reviewer writing
 * outside suggestions). The client's copy has diverged and must be reloaded.
 */
export const INVALID_UPDATE_REASON = 'invalid-update';

/** Path under which the reverse proxy exposes the collaboration WebSocket. */
export const COLLAB_PATH = '/collab';

/** Header carrying the shared secret of the internal collab routes. */
export const COLLAB_TOKEN_HEADER = 'x-galley-internal-token';

/**
 * A collaborative document: the content of one text file, or the event
 * channel of one project (never persisted, carries stateless messages only).
 */
export type CollabDocument = { kind: 'file'; id: string } | { kind: 'project'; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Hocuspocus document name of a text file. */
export function fileDocumentName(fileId: string): string {
  return `file:${fileId}`;
}

/** Hocuspocus document name of a project's event channel. */
export function projectDocumentName(projectId: string): string {
  return `project:${projectId}`;
}

/** Parses a document name; anything malformed is `null` and must be refused. */
export function parseDocumentName(name: string): CollabDocument | null {
  const separator = name.indexOf(':');
  if (separator === -1) return null;
  const kind = name.slice(0, separator);
  const id = name.slice(separator + 1);
  if (!UUID.test(id)) return null;
  if (kind === 'file' || kind === 'project') return { kind, id };
  return null;
}

/** Changes other participants of a project must hear about, relayed by collab. */
export const projectEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tree.changed') }),
  z.object({ type: z.literal('project.updated') }),
  z.object({ type: z.literal('project.deleted') }),
  /**
   * Members, invitations or links changed. `userId` names a member whose access
   * was changed or removed: collab closes their connections so they reconnect
   * with their new rights.
   */
  z.object({ type: z.literal('members.changed'), userId: z.nullable(z.uuid()) }),
  /** A comment thread was created, answered, edited, resolved or deleted. */
  z.object({ type: z.literal('review.changed'), threadId: z.uuid() }),
  /** A message was posted in the project's chat. */
  z.object({ type: z.literal('chat.message'), message: projectMessage }),
  /** A snapshot was added to the history, or a version renamed. */
  z.object({ type: z.literal('history.changed') }),
  /** A compilation of the project changed state; clients fetch it to refresh the PDF. */
  z.object({
    type: z.literal('compile.updated'),
    compileId: z.uuid(),
    status: compileStatus,
  }),
]);
export type ProjectEvent = z.infer<typeof projectEvent>;

/** Valkey channel carrying the events of one project. */
export function projectChannel(projectId: string): string {
  return `project:${projectId}`;
}

/** Event as published on Valkey and relayed to browsers. */
export const projectEventMessage = z.intersection(projectEvent, z.object({ projectId: z.uuid() }));
export type ProjectEventMessage = z.infer<typeof projectEventMessage>;

/** Body of `POST /internal/documents/:fileId/replace`. */
export const replaceDocumentRequest = z.object({ content: z.string() });
export type ReplaceDocumentRequest = z.infer<typeof replaceDocumentRequest>;
