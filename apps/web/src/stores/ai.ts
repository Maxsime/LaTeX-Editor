import {
  type AiChangeset,
  type AiChatRequest,
  type AiMode,
  type AiStreamEvent,
  type AiToolName,
  type AiUsage,
  MAX_AI_MESSAGES,
  type SnippetPreview,
} from '@galley/shared';
import { create } from 'zustand';
import { ApiRequestError } from '../lib/api.js';
import { decideHunks, streamChat } from '../lib/ai.js';

export interface ToolActivity {
  name: AiToolName;
  status: 'running' | 'done' | 'error';
  detail?: string;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  mode: AiMode;
  text: string;
  tools: ToolActivity[];
  changesetIds: string[];
  snippet: SnippetPreview | null;
  usage: AiUsage | null;
  /** Error code, translated by the interface under `errors.`. */
  error: string | null;
  done: boolean;
}

/** A selection waiting for the instruction of an inline edit (Ctrl+Alt+K). */
export interface InlineTarget {
  fileId: string;
  from: number;
  to: number;
  quote: string;
}

/**
 * Folds one streamed event into the assistant message it belongs to. Pure:
 * the store and the tests share it.
 */
export function applyEvent(message: AiMessage, event: AiStreamEvent): AiMessage {
  switch (event.type) {
    case 'text':
      return { ...message, text: message.text + event.delta };
    case 'tool': {
      // A tool's end replaces its own running line, the latest one of that name.
      const index =
        event.status === 'running'
          ? -1
          : message.tools.findLastIndex(
              (tool) => tool.name === event.name && tool.status === 'running',
            );
      const detail = event.detail ?? message.tools[index]?.detail;
      const activity: ToolActivity = {
        name: event.name,
        status: event.status,
        ...(detail === undefined ? {} : { detail }),
      };
      const tools =
        index === -1
          ? [...message.tools, activity]
          : message.tools.map((tool, at) => (at === index ? activity : tool));
      return { ...message, tools };
    }
    case 'changeset':
      return { ...message, changesetIds: [...message.changesetIds, event.changeset.id] };
    case 'snippet':
      return { ...message, snippet: event.snippet };
    case 'usage':
      return { ...message, usage: event.usage };
    case 'error':
      return { ...message, error: event.code };
    case 'done':
      return { ...message, done: true };
    case 'conversation':
      return message;
  }
}

/**
 * The history sent with a chat or fix request: earlier exchanges of those
 * modes, then the new question. Inline edits stand alone.
 */
export function historyFor(messages: readonly AiMessage[], text: string) {
  const earlier = messages
    .filter((message) => message.mode === 'chat' || message.mode === 'fix')
    .filter((message) => message.role === 'user' || (message.done && message.text !== ''))
    .map((message) => ({ role: message.role, text: message.text }));
  return [...earlier, { role: 'user' as const, text }].slice(-MAX_AI_MESSAGES);
}

export interface SendInput {
  mode: 'chat' | 'fix' | 'inline';
  text: string;
  context: AiChatRequest['context'];
  diagnostic?: AiChatRequest['diagnostic'];
}

interface AiState {
  projectId: string | null;
  conversationId: string | null;
  messages: AiMessage[];
  changesets: Record<string, AiChangeset>;
  busy: boolean;
  inline: InlineTarget | null;
  /** Bumped to bring the assistant panel to the front. */
  focus: number;
  /** Error of the last accept or reject. */
  decisionError: unknown;
  openProject: (projectId: string) => void;
  send: (input: SendInput) => Promise<void>;
  stop: () => void;
  decide: (changesetId: string, decision: 'apply' | 'reject', hunkIds: string[]) => Promise<void>;
  startInline: (target: InlineTarget) => void;
  cancelInline: () => void;
  /** Brings the assistant panel to the front. */
  show: () => void;
  /** Starts a new conversation, forgetting the messages shown. */
  clear: () => void;
}

let controller: AbortController | null = null;
let counter = 0;
const nextId = () => {
  counter += 1;
  return `m${String(counter)}`;
};

function emptyMessage(role: AiMessage['role'], mode: AiMode, text: string): AiMessage {
  return {
    id: nextId(),
    role,
    mode,
    text,
    tools: [],
    changesetIds: [],
    snippet: null,
    usage: null,
    error: null,
    done: role === 'user',
  };
}

const initial = {
  conversationId: null,
  messages: [],
  changesets: {},
  busy: false,
  inline: null,
  decisionError: null,
};

/**
 * Conversation with the assistant in the open project. The history lives in
 * this tab only: the server keeps proposals, not discussions (J09 plan).
 */
export const useAi = create<AiState>()((set, get) => ({
  projectId: null,
  ...initial,
  focus: 0,
  openProject: (projectId) => {
    if (get().projectId === projectId) return;
    controller?.abort();
    set({ projectId, ...initial });
  },
  send: async (input) => {
    const { projectId, messages, conversationId, busy } = get();
    if (projectId === null || busy) return;
    const question = emptyMessage('user', input.mode, input.text);
    const answer = emptyMessage('assistant', input.mode, '');
    set({
      messages: [...messages, question, answer],
      busy: true,
      inline: input.mode === 'inline' ? null : get().inline,
    });
    const update = (change: (message: AiMessage) => AiMessage) => {
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === answer.id ? change(message) : message,
        ),
      }));
    };
    controller = new AbortController();
    const request: AiChatRequest = {
      mode: input.mode,
      messages:
        input.mode === 'inline'
          ? [{ role: 'user', text: input.text }]
          : historyFor(messages, input.text),
      context: input.context,
      ...(conversationId === null ? {} : { conversationId }),
      ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
    };
    try {
      await streamChat(
        projectId,
        request,
        (event) => {
          if (event.type === 'conversation') set({ conversationId: event.id });
          if (event.type === 'changeset') {
            set((state) => ({
              changesets: { ...state.changesets, [event.changeset.id]: event.changeset },
            }));
          }
          update((message) => applyEvent(message, event));
        },
        controller.signal,
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        update((message) => ({
          ...message,
          error: error instanceof ApiRequestError ? error.code : 'INTERNAL_ERROR',
        }));
      }
    } finally {
      controller = null;
      update((message) => ({ ...message, done: true }));
      set({ busy: false });
    }
  },
  stop: () => {
    controller?.abort();
  },
  decide: async (changesetId, decision, hunkIds) => {
    const { projectId } = get();
    if (projectId === null || hunkIds.length === 0) return;
    set({ decisionError: null });
    try {
      const changeset = await decideHunks(projectId, changesetId, decision, hunkIds);
      set((state) => ({ changesets: { ...state.changesets, [changeset.id]: changeset } }));
    } catch (error) {
      set({ decisionError: error });
    }
  },
  startInline: (inline) => {
    set((state) => ({ inline, focus: state.focus + 1 }));
  },
  cancelInline: () => {
    set({ inline: null });
  },
  show: () => {
    set((state) => ({ focus: state.focus + 1 }));
  },
  clear: () => {
    controller?.abort();
    set({ ...initial });
  },
}));

/** Pending hunks of every changeset of the conversation that touch `fileId`. */
export function pendingHunksOf(changesets: Record<string, AiChangeset>, fileId: string) {
  return Object.values(changesets).flatMap((changeset) =>
    changeset.hunks
      .filter((hunk) => hunk.fileId === fileId && hunk.status === 'pending')
      .map((hunk) => ({ ...hunk, changesetId: changeset.id })),
  );
}
