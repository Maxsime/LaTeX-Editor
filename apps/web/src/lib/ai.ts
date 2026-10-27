import {
  type AiChangeset,
  type AiChatRequest,
  type AiHunk,
  type AiProviderSettings,
  type AiStatus,
  type AiStreamEvent,
  type AiToolName,
  type AiUsageSummary,
  aiImageTypes,
  aiStreamEvent,
  type GenerateKind,
  MAX_AI_IMAGE_BYTES,
  type PutAiProviderRequest,
  type SnippetPreview,
} from '@galley/shared';
import { diffLines } from 'diff';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError, csrfHeaders, errorOf } from './api.js';

// Under the project's key, so that project events (project.updated) refresh it.
export const aiStatusKey = (projectId: string) => ['project', projectId, 'ai'] as const;
const providerKey = ['ai', 'provider'] as const;
const usageKey = ['ai', 'usage'] as const;

/**
 * Splits the text received so far into complete server-sent events and the
 * unfinished rest. Each event of the chat route is one `data:` line of JSON;
 * an event that does not match the contract is dropped.
 */
export function splitEvents(buffer: string): { events: AiStreamEvent[]; rest: string } {
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: AiStreamEvent[] = [];
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const parsed = aiStreamEvent.safeParse(json);
    if (parsed.success) events.push(parsed.data);
  }
  return { events, rest };
}

/**
 * Sends one request to the assistant and calls `onEvent` for each streamed
 * event. A refusal before the stream starts (assistant disabled, model
 * without vision…) rejects with an {@link ApiRequestError}.
 */
export async function streamChat(
  projectId: string,
  request: AiChatRequest,
  onEvent: (event: AiStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/projects/${projectId}/ai/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...csrfHeaders(),
      },
      body: JSON.stringify(request),
      credentials: 'same-origin',
      signal: signal ?? null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(0, 'SERVICE_UNAVAILABLE');
  }
  if (!response.ok) throw await errorOf(response);
  if (response.body === null) throw new ApiRequestError(response.status, 'AI_BAD_RESPONSE');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const split = splitEvents(buffer + value);
    buffer = split.rest;
    for (const event of split.events) onEvent(event);
  }
  for (const event of splitEvents(`${buffer}\n\n`).events) onEvent(event);
}

/** One line of a hunk's differential. */
export interface DiffLine {
  kind: 'context' | 'removed' | 'added';
  text: string;
}

/** Line differential of a hunk, by the library the history already uses. */
export function hunkDiff(hunk: Pick<AiHunk, 'original' | 'replacement'>): DiffLine[] {
  return diffLines(hunk.original, hunk.replacement).flatMap((change) => {
    const kind: DiffLine['kind'] = change.added ? 'added' : change.removed ? 'removed' : 'context';
    const lines = change.value.replace(/\n$/, '').split('\n');
    return lines.map((text) => ({ kind, text }));
  });
}

/** Hunks of a changeset grouped by file, in the order the files first appear. */
export function hunksByFile<T extends Pick<AiHunk, 'path'>>(hunks: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const hunk of hunks) {
    const group = groups.get(hunk.path);
    if (group) group.push(hunk);
    else groups.set(hunk.path, [hunk]);
  }
  return [...groups];
}

/** Package names a preamble's `\usepackage` lines load. */
export function preamblePackages(preamble: string): string[] {
  const names: string[] = [];
  for (const match of preamble.matchAll(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const name of (match[1] ?? '').split(',')) {
      const trimmed = name.trim();
      if (trimmed !== '' && !names.includes(trimmed)) names.push(trimmed);
    }
  }
  return names;
}

/** Formats a cost given in millionths of a currency. */
export function formatCost(micros: number, currency: string, language: string): string {
  return new Intl.NumberFormat(language, {
    style: 'currency',
    currency,
    maximumFractionDigits: micros < 10_000 ? 4 : 2,
  }).format(micros / 1_000_000);
}

/** Whether the assistant may be used in a project, and with which model. */
export function useAiStatus(projectId: string) {
  return useQuery({
    queryKey: aiStatusKey(projectId),
    queryFn: ({ signal }) =>
      api<AiStatus>('GET', `/api/projects/${projectId}/ai/status`, { signal }),
  });
}

/** Accepts or rejects hunks of a changeset; the server answers with the changeset updated. */
export function decideHunks(
  projectId: string,
  changesetId: string,
  decision: 'apply' | 'reject',
  hunkIds: string[],
): Promise<AiChangeset> {
  return api<{ changeset: AiChangeset }>(
    'POST',
    `/api/projects/${projectId}/ai/changesets/${changesetId}/${decision}`,
    { json: { hunkIds } },
  ).then((body) => body.changeset);
}

/** URL of the PDF of a compiled snippet. */
export function snippetPdfUrl(projectId: string, compileId: string): string {
  return `/api/projects/${projectId}/ai/snippets/${compileId}/pdf`;
}

/** The user's provider configuration and the instance default. */
export function useAiProvider() {
  return useQuery({
    queryKey: providerKey,
    queryFn: ({ signal }) => api<AiProviderSettings>('GET', '/api/me/ai/provider', { signal }),
  });
}

export function useAiProviderMutations() {
  const client = useQueryClient();
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: providerKey });
    // Every project's status depends on the configuration.
    await client.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'project' && query.queryKey[2] === 'ai',
    });
  };
  return {
    save: useMutation({
      mutationFn: (body: PutAiProviderRequest) =>
        api<AiProviderSettings>('PUT', '/api/me/ai/provider', { json: body }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: () => api<undefined>('DELETE', '/api/me/ai/provider'),
      onSuccess: refresh,
    }),
  };
}

/** The user's consumption since the start of the month. */
export function useAiUsage() {
  return useQuery({
    queryKey: usageKey,
    queryFn: ({ signal }) => api<AiUsageSummary>('GET', '/api/me/ai/usage', { signal }),
  });
}

/** An image sent to the model, base64-encoded. */
export interface AiImage {
  mediaType: (typeof aiImageTypes)[number];
  data: string;
}

export interface GenerationInput {
  kind: GenerateKind;
  text: string;
  image?: AiImage;
  fileId?: string;
}

export interface GenerationState {
  busy: boolean;
  tools: AiToolName[];
  snippet: SnippetPreview | null;
  /** Error code, translated under `errors.`. */
  error: string | null;
}

const idle: GenerationState = { busy: false, tools: [], snippet: null, error: null };

/**
 * One request of the generation dialog (table, figure, formula, from a
 * description or an image): the snippet comes back with its compiled preview.
 */
export function useGeneration(projectId: string) {
  const [state, setState] = useState<GenerationState>(idle);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const run = async (input: GenerationInput) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ ...idle, busy: true });
    try {
      await streamChat(
        projectId,
        {
          mode: input.image === undefined ? 'generate' : 'image',
          kind: input.kind,
          messages: [{ role: 'user', text: input.text }],
          context: input.fileId === undefined ? {} : { fileId: input.fileId },
          ...(input.image === undefined ? {} : { image: input.image }),
        },
        (event) => {
          if (event.type === 'tool' && event.status === 'running') {
            setState((previous) => ({ ...previous, tools: [...previous.tools, event.name] }));
          } else if (event.type === 'snippet') {
            setState((previous) => ({ ...previous, snippet: event.snippet }));
          } else if (event.type === 'error') {
            setState((previous) => ({ ...previous, error: event.code }));
          }
        },
        current.signal,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState((previous) => ({
        ...previous,
        error: error instanceof ApiRequestError ? error.code : 'INTERNAL_ERROR',
      }));
    } finally {
      if (controller.current === current) setState((previous) => ({ ...previous, busy: false }));
    }
  };
  const reset = () => {
    controller.current?.abort();
    setState(idle);
  };
  return { state, run, reset };
}

/** Reads an image chosen by the user as base64, or explains why it cannot be sent. */
export async function readImage(
  file: File,
): Promise<{ ok: true; image: AiImage } | { ok: false; reason: 'type' | 'size' }> {
  const mediaType = aiImageTypes.find((type) => type === file.type);
  if (mediaType === undefined) return { ok: false, reason: 'type' };
  if (file.size > MAX_AI_IMAGE_BYTES) return { ok: false, reason: 'size' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // Chunks keep String.fromCharCode under the engines' argument limits.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { ok: true, image: { mediaType, data: btoa(binary) } };
}
