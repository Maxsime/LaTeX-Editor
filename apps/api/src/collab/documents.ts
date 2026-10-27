import { type Database, yjsStates } from '@galley/db';
import {
  applyEdits,
  COLLAB_TOKEN_HEADER,
  type EditDocumentRequest,
  type EditDocumentResponse,
  editDocumentResponse,
  realignHunks,
  type ReplaceDocumentRequest,
} from '@galley/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { ApiConfig } from '../config.js';
import type { DocumentChanges } from '../files/tree.js';
import { stateToText, textToState } from '../yjs/text.js';

/**
 * Access to text documents that collab may hold in memory. The API never
 * writes an existing document's state itself when collab is configured:
 * collab applies the change to the live document and persists it.
 */
export interface DocumentGateway {
  /** Makes the stored states of a project's open documents current. */
  flushProject(projectId: string): Promise<void>;
  /** Applies the document changes of a committed transaction. */
  apply(changes: DocumentChanges): Promise<void>;
  /**
   * Applies accepted assistant hunks to a file, realigned on its current text
   * (SPEC §6.8); `null` when the file is gone.
   */
  edit(fileId: string, request: EditDocumentRequest): Promise<EditDocumentResponse | null>;
}

const TIMEOUT_MS = 10_000;

/** Writes states directly, for an API running without collab (unit and API tests). */
function directGateway(database: Database): DocumentGateway {
  return {
    flushProject: () => Promise.resolve(),
    async apply({ replaced }) {
      for (const { fileId, content } of replaced) {
        const state = textToState(content);
        await database.db
          .insert(yjsStates)
          .values({ fileId, state })
          .onConflictDoUpdate({ target: yjsStates.fileId, set: { state, updatedAt: new Date() } });
      }
    },
    async edit(fileId, { hunks }) {
      return database.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ state: yjsStates.state })
          .from(yjsStates)
          .where(eq(yjsStates.fileId, fileId))
          .for('update');
        if (!row) return null;
        const text = stateToText(row.state);
        const { edits, results } = realignHunks(text, hunks);
        if (edits.length > 0) {
          await tx
            .update(yjsStates)
            .set({ state: textToState(applyEdits(text, edits)), updatedAt: new Date() })
            .where(eq(yjsStates.fileId, fileId));
        }
        return {
          results: hunks.map((hunk) => ({
            id: hunk.id,
            status: results.get(hunk.id) ?? 'conflict',
          })),
        };
      });
    },
  };
}

/**
 * Builds the gateway: through collab's internal routes when
 * `COLLAB_INTERNAL_URL` is set, by direct writes otherwise.
 *
 * When collab cannot be reached, nobody can be editing either, so the stored
 * states are current: flushes are skipped and replacements written directly.
 */
export function createDocumentGateway(
  config: ApiConfig,
  database: Database,
  logger: FastifyBaseLogger,
): DocumentGateway {
  const base = config.COLLAB_INTERNAL_URL;
  const token = config.COLLAB_INTERNAL_TOKEN;
  const direct = directGateway(database);
  if (base === undefined || token === undefined) return direct;

  /** Returns the response, or `null` when collab could not be reached. */
  async function request(
    path: string,
    body?: ReplaceDocumentRequest | EditDocumentRequest,
  ): Promise<Response | null> {
    const headers: Record<string, string> = { [COLLAB_TOKEN_HEADER]: token ?? '' };
    const init: RequestInit = { method: 'POST', headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      return await fetch(new URL(`/internal/${path}`, base), init);
    } catch (error) {
      logger.warn({ err: error, path }, 'collab unreachable');
      return null;
    }
  }

  /** Returns the response status, or `null` when collab could not be reached. */
  async function call(path: string, body?: ReplaceDocumentRequest): Promise<number | null> {
    const response = await request(path, body);
    await response?.body?.cancel();
    return response?.status ?? null;
  }

  function expectNoContent(status: number | null, path: string): void {
    if (status !== null && status !== 204) {
      logger.error({ status, path }, 'collab internal call failed');
    }
  }

  return {
    async flushProject(projectId) {
      const path = `projects/${projectId}/flush`;
      expectNoContent(await call(path), path);
    },
    async apply({ replaced, closed }) {
      for (const fileId of closed) {
        const path = `documents/${fileId}/close`;
        expectNoContent(await call(path), path);
      }
      for (const change of replaced) {
        const path = `documents/${change.fileId}/replace`;
        const status = await call(path, { content: change.content });
        if (status === null) {
          await direct.apply({ replaced: [change], closed: [] });
        } else if (status !== 404) {
          // 404: deleted in the meantime, nothing left to replace.
          expectNoContent(status, path);
        }
      }
    },
    async edit(fileId, body) {
      const path = `documents/${fileId}/edit`;
      const response = await request(path, body);
      if (response === null) return direct.edit(fileId, body);
      if (response.status === 404) return null;
      const parsed = editDocumentResponse.safeParse(
        response.ok ? await response.json() : undefined,
      );
      if (!parsed.success) {
        logger.error({ status: response.status, path }, 'collab internal call failed');
        throw new Error('collab edit failed');
      }
      return parsed.data;
    },
  };
}
