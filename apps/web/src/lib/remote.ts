import type {
  ProjectRemote,
  PullResponse,
  PushResponse,
  RemoteResponse,
  SetRemoteRequest,
} from '@galley/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';

// Under the project's key, so that project events refresh it with the rest.
const remoteKey = (projectId: string) => ['project', projectId, 'remote'] as const;

/** The GitHub or GitLab repository a project is synchronised with. */
export function useRemote(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: remoteKey(projectId),
    queryFn: () => api<RemoteResponse>('GET', `/api/projects/${projectId}/remote`),
    enabled,
  });
}

export function useRemoteMutations(projectId: string) {
  const client = useQueryClient();
  // A pull changes the files and the history; both live under the project's key.
  const refresh = () => client.invalidateQueries({ queryKey: ['project', projectId] });
  const path = `/api/projects/${projectId}/remote`;
  return {
    set: useMutation({
      mutationFn: (body: SetRemoteRequest) => api<ProjectRemote>('PUT', path, { json: body }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: () => api('DELETE', path),
      onSuccess: refresh,
    }),
    pull: useMutation({
      mutationFn: () => api<PullResponse>('POST', `${path}/pull`),
      onSettled: refresh,
    }),
    push: useMutation({
      mutationFn: () => api<PushResponse>('POST', `${path}/push`),
      onSettled: refresh,
    }),
  };
}
