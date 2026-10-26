import * as z from 'zod/mini';

/** Name of the shared text holding a file's content, fixed for the whole application. */
export const TEXT_KEY = 'content';

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
