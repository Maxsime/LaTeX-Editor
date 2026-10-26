import type {
  OutlineResponse,
  ProjectIndexResponse,
  ReplaceRequest,
  ReplaceResponse,
  SearchResponse,
} from '@galley/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';

export const outlineKey = (projectId: string) => ['project', projectId, 'outline'] as const;
export const indexKey = (projectId: string) => ['project', projectId, 'index'] as const;

export function useOutline(projectId: string) {
  return useQuery({
    queryKey: outlineKey(projectId),
    queryFn: ({ signal }) =>
      api<OutlineResponse>('GET', `/api/projects/${projectId}/outline`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useProjectIndex(projectId: string) {
  return useQuery({
    queryKey: indexKey(projectId),
    queryFn: ({ signal }) =>
      api<ProjectIndexResponse>('GET', `/api/projects/${projectId}/index`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export interface SearchInput {
  q: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** Project-wide search; runs when `input` is set, i.e. when the user submits. */
export function useProjectSearch(projectId: string, input: SearchInput | null) {
  return useQuery({
    queryKey: ['project', projectId, 'search', input],
    enabled: input !== null && input.q !== '',
    queryFn: ({ signal }) =>
      api<SearchResponse>('GET', `/api/projects/${projectId}/search`, {
        signal,
        query: {
          q: input?.q,
          regex: String(input?.regex ?? false),
          caseSensitive: String(input?.caseSensitive ?? false),
          wholeWord: String(input?.wholeWord ?? false),
        },
      }),
    // Results are a snapshot: the user searches again to refresh them.
    staleTime: Infinity,
  });
}

export function useProjectReplace(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: ReplaceRequest) =>
      api<ReplaceResponse>('POST', `/api/projects/${projectId}/replace`, { json: request }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['project', projectId, 'search'] }),
  });
}
