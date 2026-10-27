import type { AccessTokensResponse, CreatedAccessToken } from '@galley/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';

const tokensKey = ['tokens'] as const;

/** URL to clone a project with Git, on this server. */
export function cloneUrl(projectId: string): string {
  return `${window.location.origin}/git/${projectId}`;
}

export function useAccessTokens() {
  return useQuery({
    queryKey: tokensKey,
    queryFn: () => api<AccessTokensResponse>('GET', '/api/tokens').then((body) => body.tokens),
  });
}

export function useAccessTokenMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: tokensKey });
  return {
    create: useMutation({
      mutationFn: (input: { name: string; expiresInDays?: number }) =>
        api<CreatedAccessToken>('POST', '/api/tokens', { json: input }),
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: (id: string) => api('DELETE', `/api/tokens/${id}`),
      onSettled: refresh,
    }),
  };
}
