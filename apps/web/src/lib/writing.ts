import type {
  DictionaryResponse,
  LookupRequest,
  LookupResponse,
  ProjectIndexResponse,
  WritingFeatures,
  ZoteroAccount,
  ZoteroItemsResponse,
} from '@galley/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';

const featuresKey = ['writing', 'features'] as const;
const dictionaryKey = ['me', 'dictionary'] as const;
const zoteroKey = ['me', 'zotero'] as const;

/** Spell checking and Zotero, when this instance offers them. */
export function useWritingFeatures() {
  return useQuery({
    queryKey: featuresKey,
    queryFn: () => api<WritingFeatures>('GET', '/api/writing/features'),
    staleTime: Infinity,
  });
}

export function useDictionary(enabled = true) {
  return useQuery({
    queryKey: dictionaryKey,
    enabled,
    queryFn: () => api<DictionaryResponse>('GET', '/api/me/dictionary').then((body) => body.words),
  });
}

export function useDictionaryMutations() {
  const client = useQueryClient();
  const store = (body: DictionaryResponse) => {
    client.setQueryData(dictionaryKey, body.words);
  };
  return {
    add: useMutation({
      mutationFn: (word: string) =>
        api<DictionaryResponse>('POST', '/api/me/dictionary', { json: { word } }),
      onSuccess: store,
    }),
    remove: useMutation({
      mutationFn: (word: string) =>
        api<DictionaryResponse>('DELETE', '/api/me/dictionary', { query: { word } }),
      onSuccess: store,
    }),
  };
}

export function useZoteroAccount(enabled = true) {
  return useQuery({
    queryKey: zoteroKey,
    queryFn: () => api<ZoteroAccount>('GET', '/api/zotero'),
    enabled,
  });
}

export function useZoteroMutations() {
  const client = useQueryClient();
  const store = (account: ZoteroAccount) => {
    client.setQueryData(zoteroKey, account);
  };
  return {
    connect: useMutation({
      mutationFn: (apiKey: string) =>
        api<ZoteroAccount>('PUT', '/api/zotero', { json: { apiKey } }),
      onSuccess: store,
    }),
    disconnect: useMutation({
      mutationFn: () => api<undefined>('DELETE', '/api/zotero'),
      onSuccess: () => {
        store({ connected: false, username: null, keyHint: null });
      },
    }),
  };
}

export function useZoteroItems(q: string | null) {
  return useQuery({
    queryKey: ['me', 'zotero', 'items', q],
    enabled: q !== null,
    queryFn: ({ signal }) =>
      api<ZoteroItemsResponse>('GET', '/api/zotero/items', { query: { q: q ?? '' }, signal }).then(
        (body) => body.items,
      ),
    staleTime: 60_000,
  });
}

/** Lookups by identifier or pasted BibTeX, and Zotero imports, as entries to add. */
export function useBibliographyImport(projectId: string) {
  return {
    lookup: useMutation({
      mutationFn: (request: LookupRequest) =>
        api<LookupResponse>('POST', `/api/projects/${projectId}/bibliography/lookup`, {
          json: request,
        }).then((body) => body.entries),
    }),
    zotero: useMutation({
      mutationFn: (itemKeys: string[]) =>
        api<LookupResponse>('POST', `/api/projects/${projectId}/zotero/import`, {
          json: { itemKeys },
        }).then((body) => body.entries),
    }),
  };
}

export type IndexedEntry = ProjectIndexResponse['citations'][number];

/** A bibliography entry as the References panel lists it. */
export interface ReferenceRow extends IndexedEntry {
  cited: boolean;
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Entries matching every word of `query` in their key, title, authors or
 * year; uncited entries can be listed alone. Sorted by key.
 */
export function filterReferences(
  index: Pick<ProjectIndexResponse, 'citations' | 'cited'>,
  query: string,
  only: 'all' | 'cited' | 'uncited' = 'all',
): ReferenceRow[] {
  const cited = new Set(index.cited);
  const words = fold(query).split(/\s+/).filter(Boolean);
  return index.citations
    .map((entry) => ({ ...entry, cited: cited.has(entry.key) }))
    .filter((entry) => only === 'all' || entry.cited === (only === 'cited'))
    .filter((entry) => {
      const haystack = fold(
        [entry.key, entry.title ?? '', entry.authors.join(' '), entry.year ?? ''].join(' '),
      );
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Entries joined as one block, each after a blank line. */
export function joinEntries(entries: readonly string[]): string {
  return entries.map((entry) => entry.trimEnd()).join('\n\n');
}

/** Text to append to a file so that `block` starts after a blank line and ends with a newline. */
export function appendedBlock(current: string, block: string): string {
  const body = block.trimEnd();
  if (current.trim() === '') return `${body}\n`;
  const separator = current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return `${separator}${body}\n`;
}

/** Reads a list of chktex rule numbers typed as `1, 8 13`; null when a value is not a rule. */
export function parseRules(value: string): number[] | null {
  const parts = value.split(/[\s,;]+/).filter(Boolean);
  const rules = parts.map(Number);
  if (rules.some((rule) => !Number.isInteger(rule) || rule < 1 || rule > 99)) return null;
  return [...new Set(rules)].sort((a, b) => a - b);
}
