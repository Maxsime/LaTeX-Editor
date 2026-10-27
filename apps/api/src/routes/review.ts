import {
  commentMentions,
  comments,
  commentThreads,
  type Executor,
  files,
  projectMembers,
  projectMessages,
  projects,
  users,
} from '@galley/db';
import {
  ApiError,
  type AuthorRef,
  type Comment,
  commentRequest,
  type CommentThread,
  createMessageRequest,
  createThreadRequest,
  hasRole,
  type Mention,
  mentionedUsernames,
  type MentionsResponse,
  messagesQuery,
  type MessagesResponse,
  type ProjectMessage,
  type ProjectRole,
  readMentionsRequest,
  type ThreadsResponse,
} from '@galley/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as z from 'zod/mini';
import { requireAuth } from '../auth/plugin.js';
import type { AppContext } from '../context.js';
import { parse } from '../http/validate.js';
import { loadProject } from '../projects/access.js';
import { publishProjectEvent } from '../projects/events.js';
import { projectParams } from './projects.js';

const threadParams = z.object({ id: z.uuid(), threadId: z.uuid() });
const commentParams = z.object({ id: z.uuid(), threadId: z.uuid(), commentId: z.uuid() });

const MESSAGES_PAGE = 50;
const EXCERPT_LENGTH = 200;

// SPEC §3.4: 30 chat messages per minute and per person, counted once the session is known.
const chatRateLimit = {
  rateLimit: {
    max: 30,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest) => request.auth?.user.id ?? request.ip,
  },
};

type UserRow = Pick<typeof users.$inferSelect, 'id' | 'displayName' | 'username'>;

async function usersById(
  db: Executor,
  ids: Iterable<string | null>,
): Promise<Map<string, UserRow>> {
  const wanted = [...new Set([...ids].filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, username: users.username })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((row) => [row.id, row]));
}

function authorRef(people: Map<string, UserRow>, id: string | null): AuthorRef {
  const person = id === null ? undefined : people.get(id);
  return person === undefined
    ? null
    : { id: person.id, displayName: person.displayName, username: person.username };
}

/** Threads of a project, or the listed ones, with their comments, oldest first. */
async function loadThreads(
  db: Executor,
  projectId: string,
  only?: readonly string[],
): Promise<CommentThread[]> {
  const threadRows = await db
    .select()
    .from(commentThreads)
    .where(
      only === undefined
        ? eq(commentThreads.projectId, projectId)
        : and(eq(commentThreads.projectId, projectId), inArray(commentThreads.id, [...only])),
    )
    .orderBy(asc(commentThreads.createdAt));
  if (threadRows.length === 0) return [];
  const commentRows = await db
    .select()
    .from(comments)
    .where(
      inArray(
        comments.threadId,
        threadRows.map((row) => row.id),
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id));
  const people = await usersById(db, [
    ...threadRows.flatMap((row) => [row.authorId, row.resolvedBy]),
    ...commentRows.map((row) => row.authorId),
  ]);
  const byThread = new Map<string, Comment[]>();
  for (const row of commentRows) {
    const list = byThread.get(row.threadId) ?? [];
    list.push({
      id: row.id,
      author: authorRef(people, row.authorId),
      body: row.deletedAt === null ? row.body : null,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
    });
    byThread.set(row.threadId, list);
  }
  return threadRows.map((row) => ({
    id: row.id,
    fileId: row.fileId,
    quote: row.quote,
    author: authorRef(people, row.authorId),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: authorRef(people, row.resolvedBy),
    comments: byThread.get(row.id) ?? [],
  }));
}

async function loadThread(db: Executor, projectId: string, threadId: string) {
  const [row] = await db
    .select()
    .from(commentThreads)
    .where(and(eq(commentThreads.id, threadId), eq(commentThreads.projectId, projectId)))
    .limit(1);
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

/** Records who a comment names: members of the project, other than its author. */
async function recordMentions(
  db: Executor,
  projectId: string,
  commentId: string,
  authorId: string,
  body: string,
): Promise<void> {
  const names = mentionedUsernames(body);
  if (names.length === 0) return;
  const named = await db
    .select({ id: users.id })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        // citext compares without case, as usernames are unique without case.
        inArray(users.username, names),
      ),
    );
  const targets = named.filter((row) => row.id !== authorId);
  if (targets.length === 0) return;
  await db
    .insert(commentMentions)
    .values(targets.map((row) => ({ commentId, userId: row.id })))
    .onConflictDoNothing();
}

/** Who may resolve, reopen or delete a thread: its author while a reviewer, editors and the owner. */
function mayManage(role: ProjectRole, userId: string, authorId: string | null): boolean {
  return hasRole(role, 'editor') || (hasRole(role, 'reviewer') && authorId === userId);
}

/**
 * Comment threads, mentions and the project chat (SPEC §3.4). Anchors of the
 * threads live in the files' Yjs documents, written by the clients.
 */
export function reviewRoutes(app: FastifyInstance, { database, redis }: AppContext): void {
  const { db } = database;

  async function changed(projectId: string, threadId: string): Promise<void> {
    await publishProjectEvent(redis, projectId, { type: 'review.changed', threadId });
  }

  async function threadById(projectId: string, threadId: string): Promise<CommentThread> {
    const [thread] = await loadThreads(db, projectId, [threadId]);
    if (thread === undefined) throw new ApiError('NOT_FOUND');
    return thread;
  }

  app.get('/api/projects/:id/threads', async (request): Promise<ThreadsResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    await loadProject(db, id, auth.user.id, 'reader');
    return { threads: await loadThreads(db, id) };
  });

  app.post('/api/projects/:id/threads', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const body = parse(createThreadRequest, request.body);
    await loadProject(db, id, auth.user.id, 'reviewer');
    const threadId = await db.transaction(async (tx) => {
      const [file] = await tx
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.id, body.fileId), eq(files.projectId, id), eq(files.kind, 'text')))
        .limit(1);
      if (!file) throw new ApiError('NOT_FOUND');
      const [thread] = await tx
        .insert(commentThreads)
        .values({ projectId: id, fileId: file.id, authorId: auth.user.id, quote: body.quote })
        .returning({ id: commentThreads.id });
      if (!thread) throw new ApiError('INTERNAL_ERROR');
      const [first] = await tx
        .insert(comments)
        .values({ threadId: thread.id, authorId: auth.user.id, body: body.body })
        .returning({ id: comments.id });
      if (!first) throw new ApiError('INTERNAL_ERROR');
      await recordMentions(tx, id, first.id, auth.user.id, body.body);
      return thread.id;
    });
    await changed(id, threadId);
    return reply.status(201).send(await threadById(id, threadId));
  });

  app.post('/api/projects/:id/threads/:threadId/comments', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, threadId } = parse(threadParams, request.params);
    const { body } = parse(commentRequest, request.body);
    await loadProject(db, id, auth.user.id, 'reviewer');
    await db.transaction(async (tx) => {
      await loadThread(tx, id, threadId);
      const [created] = await tx
        .insert(comments)
        .values({ threadId, authorId: auth.user.id, body })
        .returning({ id: comments.id });
      if (!created) throw new ApiError('INTERNAL_ERROR');
      await recordMentions(tx, id, created.id, auth.user.id, body);
    });
    await changed(id, threadId);
    return reply.status(201).send(await threadById(id, threadId));
  });

  /** Loads a comment its author may change: their own, not deleted, while still a reviewer. */
  async function ownComment(request: FastifyRequest) {
    const auth = requireAuth(request);
    const params = parse(commentParams, request.params);
    await loadProject(db, params.id, auth.user.id, 'reviewer');
    await loadThread(db, params.id, params.threadId);
    const [row] = await db
      .select()
      .from(comments)
      .where(and(eq(comments.id, params.commentId), eq(comments.threadId, params.threadId)))
      .limit(1);
    if (row?.deletedAt !== null) throw new ApiError('NOT_FOUND');
    if (row.authorId !== auth.user.id) throw new ApiError('FORBIDDEN');
    return { auth, params, row };
  }

  app.patch('/api/projects/:id/threads/:threadId/comments/:commentId', async (request) => {
    const { auth, params } = await ownComment(request);
    const { body } = parse(commentRequest, request.body);
    await db.transaction(async (tx) => {
      await tx
        .update(comments)
        .set({ body, editedAt: new Date() })
        .where(eq(comments.id, params.commentId));
      await recordMentions(tx, params.id, params.commentId, auth.user.id, body);
    });
    await changed(params.id, params.threadId);
    return threadById(params.id, params.threadId);
  });

  app.delete('/api/projects/:id/threads/:threadId/comments/:commentId', async (request) => {
    const { params } = await ownComment(request);
    await db.transaction(async (tx) => {
      await tx
        .update(comments)
        .set({ body: '', deletedAt: new Date() })
        .where(eq(comments.id, params.commentId));
      await tx.delete(commentMentions).where(eq(commentMentions.commentId, params.commentId));
    });
    await changed(params.id, params.threadId);
    return threadById(params.id, params.threadId);
  });

  function resolution(path: string, resolved: boolean): void {
    app.post(`/api/projects/:id/threads/:threadId/${path}`, async (request) => {
      const auth = requireAuth(request);
      const { id, threadId } = parse(threadParams, request.params);
      const { role } = await loadProject(db, id, auth.user.id, 'reviewer');
      const thread = await loadThread(db, id, threadId);
      if (!mayManage(role, auth.user.id, thread.authorId)) throw new ApiError('FORBIDDEN');
      await db
        .update(commentThreads)
        .set(
          resolved
            ? { resolvedAt: new Date(), resolvedBy: auth.user.id }
            : { resolvedAt: null, resolvedBy: null },
        )
        .where(eq(commentThreads.id, threadId));
      await changed(id, threadId);
      return threadById(id, threadId);
    });
  }
  resolution('resolve', true);
  resolution('reopen', false);

  app.delete('/api/projects/:id/threads/:threadId', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, threadId } = parse(threadParams, request.params);
    const { role } = await loadProject(db, id, auth.user.id, 'reviewer');
    const thread = await loadThread(db, id, threadId);
    if (!mayManage(role, auth.user.id, thread.authorId)) throw new ApiError('FORBIDDEN');
    await db.delete(commentThreads).where(eq(commentThreads.id, threadId));
    await changed(id, threadId);
    return reply.status(204).send();
  });

  app.get('/api/mentions', async (request): Promise<MentionsResponse> => {
    const auth = requireAuth(request);
    const rows = await db
      .select({
        commentId: comments.id,
        threadId: commentThreads.id,
        projectId: projects.id,
        projectName: projects.name,
        fileId: commentThreads.fileId,
        authorId: comments.authorId,
        body: comments.body,
        createdAt: comments.createdAt,
      })
      .from(commentMentions)
      .innerJoin(comments, eq(comments.id, commentMentions.commentId))
      .innerJoin(commentThreads, eq(commentThreads.id, comments.threadId))
      .innerJoin(projects, eq(projects.id, commentThreads.projectId))
      // Still a member: a mention does not outlive one's access to the project.
      .innerJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, commentMentions.userId),
        ),
      )
      .where(
        and(
          eq(commentMentions.userId, auth.user.id),
          isNull(commentMentions.readAt),
          isNull(projects.deletedAt),
        ),
      )
      .orderBy(desc(comments.createdAt))
      .limit(100);
    const people = await usersById(
      db,
      rows.map((row) => row.authorId),
    );
    const mentions: Mention[] = rows.map((row) => ({
      commentId: row.commentId,
      threadId: row.threadId,
      projectId: row.projectId,
      projectName: row.projectName,
      fileId: row.fileId,
      author: authorRef(people, row.authorId),
      excerpt: row.body.slice(0, EXCERPT_LENGTH),
      createdAt: row.createdAt.toISOString(),
    }));
    return { mentions };
  });

  app.post('/api/mentions/read', async (request, reply) => {
    const auth = requireAuth(request);
    const { threadId } = parse(readMentionsRequest, request.body);
    await db
      .update(commentMentions)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(commentMentions.userId, auth.user.id),
          isNull(commentMentions.readAt),
          inArray(
            commentMentions.commentId,
            db.select({ id: comments.id }).from(comments).where(eq(comments.threadId, threadId)),
          ),
        ),
      );
    return reply.status(204).send();
  });

  app.get('/api/projects/:id/messages', async (request): Promise<MessagesResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { before } = parse(messagesQuery, request.query);
    await loadProject(db, id, auth.user.id, 'reader');
    let cursor = sql`true`;
    if (before !== undefined) {
      const [anchor] = await db
        .select({ createdAt: projectMessages.createdAt })
        .from(projectMessages)
        .where(and(eq(projectMessages.id, before), eq(projectMessages.projectId, id)))
        .limit(1);
      if (!anchor) throw new ApiError('NOT_FOUND');
      // postgres.js takes dates in raw fragments as strings only.
      cursor = sql`(${projectMessages.createdAt}, ${projectMessages.id}) < (${anchor.createdAt.toISOString()}::timestamptz, ${before}::uuid)`;
    }
    const rows = await db
      .select()
      .from(projectMessages)
      .where(and(eq(projectMessages.projectId, id), cursor))
      .orderBy(desc(projectMessages.createdAt), desc(projectMessages.id))
      .limit(MESSAGES_PAGE + 1);
    const page = rows.slice(0, MESSAGES_PAGE);
    const people = await usersById(
      db,
      page.map((row) => row.authorId),
    );
    const messages: ProjectMessage[] = page.reverse().map((row) => ({
      id: row.id,
      author: authorRef(people, row.authorId),
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    }));
    return {
      messages,
      nextCursor: rows.length > MESSAGES_PAGE ? (messages[0]?.id ?? null) : null,
    };
  });

  app.post('/api/projects/:id/messages', { config: chatRateLimit }, async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { body } = parse(createMessageRequest, request.body);
    await loadProject(db, id, auth.user.id, 'reader');
    const [row] = await db
      .insert(projectMessages)
      .values({ projectId: id, authorId: auth.user.id, body })
      .returning();
    if (!row) throw new ApiError('INTERNAL_ERROR');
    const message: ProjectMessage = {
      id: row.id,
      author: {
        id: auth.user.id,
        displayName: auth.user.displayName,
        username: auth.user.username,
      },
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    };
    await publishProjectEvent(redis, id, { type: 'chat.message', message });
    return reply.status(201).send(message);
  });
}
