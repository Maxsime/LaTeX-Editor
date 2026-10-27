import type {
  CommentThread,
  CreateThreadRequest,
  MentionsResponse,
  MessagesResponse,
  ProjectMessage,
  ThreadsResponse,
} from '@galley/shared';
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from './api.js';

// Under the project's key, so that project events (review.changed) refresh them.
export const threadsKey = (projectId: string) => ['project', projectId, 'threads'] as const;
const messagesKey = (projectId: string) => ['chat', projectId] as const;
export const mentionsKey = ['mentions'] as const;

/** Comment threads of a project, oldest first. */
export function useThreads(projectId: string) {
  return useQuery({
    queryKey: threadsKey(projectId),
    queryFn: () =>
      api<ThreadsResponse>('GET', `/api/projects/${projectId}/threads`).then(
        (body) => body.threads,
      ),
  });
}

/** Creating, answering, editing, resolving and deleting threads and comments. */
export function useThreadMutations(projectId: string) {
  const client = useQueryClient();
  const base = `/api/projects/${projectId}/threads`;
  const store = (thread: CommentThread) => {
    client.setQueryData<CommentThread[]>(threadsKey(projectId), (threads = []) =>
      threads.some((item) => item.id === thread.id)
        ? threads.map((item) => (item.id === thread.id ? thread : item))
        : [...threads, thread],
    );
    return thread;
  };
  return {
    create: useMutation({
      mutationFn: (body: CreateThreadRequest) =>
        api<CommentThread>('POST', base, { json: body }).then(store),
    }),
    reply: useMutation({
      mutationFn: ({ threadId, body }: { threadId: string; body: string }) =>
        api<CommentThread>('POST', `${base}/${threadId}/comments`, { json: { body } }).then(store),
    }),
    edit: useMutation({
      mutationFn: ({
        threadId,
        commentId,
        body,
      }: {
        threadId: string;
        commentId: string;
        body: string;
      }) =>
        api<CommentThread>('PATCH', `${base}/${threadId}/comments/${commentId}`, {
          json: { body },
        }).then(store),
    }),
    removeComment: useMutation({
      mutationFn: ({ threadId, commentId }: { threadId: string; commentId: string }) =>
        api<CommentThread>('DELETE', `${base}/${threadId}/comments/${commentId}`).then(store),
    }),
    resolve: useMutation({
      mutationFn: ({ threadId, resolved }: { threadId: string; resolved: boolean }) =>
        api<CommentThread>('POST', `${base}/${threadId}/${resolved ? 'resolve' : 'reopen'}`).then(
          store,
        ),
    }),
    remove: useMutation({
      mutationFn: async (threadId: string) => {
        await api<undefined>('DELETE', `${base}/${threadId}`);
        client.setQueryData<CommentThread[]>(threadsKey(projectId), (threads = []) =>
          threads.filter((item) => item.id !== threadId),
        );
      },
    }),
  };
}

/** Comments naming the current user, not opened yet. */
export function useMentions() {
  return useQuery({
    queryKey: mentionsKey,
    queryFn: () => api<MentionsResponse>('GET', '/api/mentions').then((body) => body.mentions),
  });
}

/** Marks the user's mentions in a thread as read, once they open it. */
export function useReadMentions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) =>
      api<undefined>('POST', '/api/mentions/read', { json: { threadId } }),
    onSuccess: () => client.invalidateQueries({ queryKey: mentionsKey }),
  });
}

/** The project's chat, newest page first; each page is oldest first. */
export function useMessages(projectId: string) {
  return useInfiniteQuery({
    queryKey: messagesKey(projectId),
    queryFn: ({ pageParam }) =>
      api<MessagesResponse>('GET', `/api/projects/${projectId}/messages`, {
        query: { before: pageParam ?? undefined },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

/**
 * Adds a message to the cached chat, from the server's answer or a live
 * event; a message already there (one's own, seen twice) is kept once.
 */
export function addMessage(client: QueryClient, projectId: string, message: ProjectMessage): void {
  client.setQueryData<InfiniteData<MessagesResponse, string | null>>(
    messagesKey(projectId),
    (data) => {
      if (data === undefined) return data;
      if (data.pages.some((page) => page.messages.some((item) => item.id === message.id))) {
        return data;
      }
      const [first, ...rest] = data.pages;
      if (first === undefined) return data;
      return { ...data, pages: [{ ...first, messages: [...first.messages, message] }, ...rest] };
    },
  );
}

export function useSendMessage(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api<ProjectMessage>('POST', `/api/projects/${projectId}/messages`, { json: { body } }),
    onSuccess: (message) => {
      addMessage(client, projectId, message);
    },
  });
}

/** 1-based line and 0-based column of a character index, for the editor's reveal. */
export function lineColumnAt(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(index, text.length)));
  const lastBreak = before.lastIndexOf('\n');
  let line = 1;
  for (const char of before) if (char === '\n') line += 1;
  return { line, column: before.length - lastBreak - 1 };
}
