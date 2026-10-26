import type { AuthConfigResponse, PublicUser, SessionResponse } from '@galley/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken } from './api.js';

export const sessionKey = ['auth', 'session'] as const;

async function fetchSession(): Promise<SessionResponse> {
  const session = await api<SessionResponse>('GET', '/api/auth/session');
  setCsrfToken(session.csrfToken);
  return session;
}

/** Current user, or `null` when signed out; `undefined` while loading. */
export function useSession(): { user: PublicUser | null | undefined; isLoading: boolean } {
  const query = useQuery({ queryKey: sessionKey, queryFn: fetchSession, staleTime: 60_000 });
  return {
    user: query.data?.user ?? (query.isLoading ? undefined : null),
    isLoading: query.isLoading,
  };
}

export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth', 'config'],
    queryFn: () => api<AuthConfigResponse>('GET', '/api/auth/config'),
  });
}

/** Reloads the session after signing in or out, and drops data of the previous user. */
export function useRefreshSession(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
    await client.invalidateQueries({ queryKey: ['auth'] });
  };
}
