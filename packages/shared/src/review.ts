import * as z from 'zod/mini';

/** Longest comment or chat message, in characters (SPEC §3.4). */
export const MAX_MESSAGE_LENGTH = 4000;

/** Longest quote kept with a comment thread; longer selections are cut. */
export const MAX_QUOTE_LENGTH = 500;

const messageBody = z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MESSAGE_LENGTH));

/** Who wrote something; `null` once their account is deleted. */
export const authorRef = z.nullable(
  z.object({ id: z.uuid(), displayName: z.string(), username: z.string() }),
);
export type AuthorRef = z.infer<typeof authorRef>;

export const comment = z.object({
  id: z.uuid(),
  author: authorRef,
  /** `null` once deleted: the comment keeps its place in the thread. */
  body: z.nullable(z.string()),
  createdAt: z.string(),
  editedAt: z.nullable(z.string()),
});
export type Comment = z.infer<typeof comment>;

export const commentThread = z.object({
  id: z.uuid(),
  /** `null` once the file is deleted. */
  fileId: z.nullable(z.uuid()),
  quote: z.string(),
  author: authorRef,
  createdAt: z.string(),
  resolvedAt: z.nullable(z.string()),
  resolvedBy: authorRef,
  comments: z.array(comment),
});
export type CommentThread = z.infer<typeof commentThread>;

export const threadsResponse = z.object({ threads: z.array(commentThread) });
export type ThreadsResponse = z.infer<typeof threadsResponse>;

/** Body of `POST /api/projects/:id/threads`. The client then writes the anchor under the thread's id. */
export const createThreadRequest = z.object({
  fileId: z.uuid(),
  quote: z.string().check(z.maxLength(MAX_QUOTE_LENGTH)),
  body: messageBody,
});
export type CreateThreadRequest = z.input<typeof createThreadRequest>;

/** Body of `POST .../threads/:threadId/comments` and `PATCH .../comments/:commentId`. */
export const commentRequest = z.object({ body: messageBody });
export type CommentRequest = z.input<typeof commentRequest>;

/** A comment naming the current user, not opened yet. */
export const mention = z.object({
  commentId: z.uuid(),
  threadId: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string(),
  fileId: z.nullable(z.uuid()),
  author: authorRef,
  excerpt: z.string(),
  createdAt: z.string(),
});
export type Mention = z.infer<typeof mention>;

export const mentionsResponse = z.object({ mentions: z.array(mention) });
export type MentionsResponse = z.infer<typeof mentionsResponse>;

/** Body of `POST /api/mentions/read`: the thread the user opened. */
export const readMentionsRequest = z.object({ threadId: z.uuid() });

export const projectMessage = z.object({
  id: z.uuid(),
  author: authorRef,
  body: z.string(),
  createdAt: z.string(),
});
export type ProjectMessage = z.infer<typeof projectMessage>;

export const messagesResponse = z.object({
  /** Oldest first. */
  messages: z.array(projectMessage),
  /** Pass as `before` to read older messages; null at the start of the chat. */
  nextCursor: z.nullable(z.string()),
});
export type MessagesResponse = z.infer<typeof messagesResponse>;

export const messagesQuery = z.object({ before: z.optional(z.uuid()) });

export const createMessageRequest = z.object({ body: messageBody });
export type CreateMessageRequest = z.input<typeof createMessageRequest>;

/**
 * Usernames named with `@` in a text, lower-cased and without duplicates. An
 * `@` inside a word (an e-mail address) does not count.
 */
export function mentionedUsernames(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<![\w.@-])@([A-Za-z0-9][A-Za-z0-9._-]{1,38})/g)) {
    // A sentence may end right after a mention: "thanks @alice."
    const name = match[1]?.replace(/[._-]+$/, '');
    if (name !== undefined && name.length >= 2) found.add(name.toLowerCase());
  }
  return [...found];
}
