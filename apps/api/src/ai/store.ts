import { randomBytes } from 'node:crypto';
import { aiChangeset, ApiError } from '@galley/shared';
import type { Redis } from 'ioredis';
import * as z from 'zod/mini';

/** How long conversations and proposals live: a working session, not an archive. */
const TTL_SECONDS = 24 * 3600;
const SNIPPET_TTL_SECONDS = 3600;

const conversationState = z.object({
  userId: z.string(),
  projectId: z.string(),
  /** Entries obtained through fetch_bibtex: the only ones a proposal may add to a .bib. */
  fetched: z.array(z.object({ key: z.string(), bibtex: z.string() })),
});
export type ConversationState = z.infer<typeof conversationState>;

const changesetState = z.object({
  userId: z.string(),
  projectId: z.string(),
  conversationId: z.string(),
  changeset: aiChangeset,
});
export type ChangesetState = z.infer<typeof changesetState>;

const snippetOwner = z.object({ userId: z.string(), projectId: z.string() });

/** Random identifier, unguessable: knowing one is not access, but it should not leak either. */
export function newId(): string {
  return randomBytes(16).toString('base64url');
}

async function readJson<Schema extends z.ZodMiniType>(
  redis: Redis,
  key: string,
  schema: Schema,
): Promise<z.output<Schema> | null> {
  const raw = await redis.get(key);
  if (raw === null) return null;
  const parsed = schema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

/**
 * Conversations, proposals and preview ownership, kept in Valkey with an
 * expiry (SPEC §6.2: text files live in their Yjs documents only; a proposal
 * is not a second copy, and nothing has to be purged).
 */
export class AiStore {
  constructor(private readonly redis: Redis) {}

  /** The caller's conversation, or a new one when the id is absent, unknown or not theirs. */
  async conversation(
    id: string | undefined,
    userId: string,
    projectId: string,
  ): Promise<{ id: string; state: ConversationState }> {
    if (id !== undefined) {
      const state = await readJson(this.redis, `ai:conversation:${id}`, conversationState);
      if (state !== null && state.userId === userId && state.projectId === projectId) {
        return { id, state };
      }
    }
    const fresh = { id: newId(), state: { userId, projectId, fetched: [] } };
    await this.saveConversation(fresh.id, fresh.state);
    return fresh;
  }

  async saveConversation(id: string, state: ConversationState): Promise<void> {
    await this.redis.set(`ai:conversation:${id}`, JSON.stringify(state), 'EX', TTL_SECONDS);
  }

  async saveChangeset(state: ChangesetState): Promise<void> {
    await this.redis.set(
      `ai:changeset:${state.changeset.id}`,
      JSON.stringify(state),
      'EX',
      TTL_SECONDS,
    );
  }

  /** A proposal of the caller on this project; NOT_FOUND otherwise, without telling which. */
  async changeset(id: string, userId: string, projectId: string): Promise<ChangesetState> {
    const state = await readJson(this.redis, `ai:changeset:${id}`, changesetState);
    if (state?.userId !== userId || state.projectId !== projectId) {
      throw new ApiError('NOT_FOUND');
    }
    return state;
  }

  async conversationOf(state: ChangesetState): Promise<ConversationState | null> {
    return readJson(this.redis, `ai:conversation:${state.conversationId}`, conversationState);
  }

  async recordSnippet(compileId: string, userId: string, projectId: string): Promise<void> {
    await this.redis.set(
      `ai:snippet:${compileId}`,
      JSON.stringify({ userId, projectId }),
      'EX',
      SNIPPET_TTL_SECONDS,
    );
  }

  async snippetBelongsTo(compileId: string, userId: string, projectId: string): Promise<boolean> {
    const owner = await readJson(this.redis, `ai:snippet:${compileId}`, snippetOwner);
    return owner?.userId === userId && owner.projectId === projectId;
  }
}
