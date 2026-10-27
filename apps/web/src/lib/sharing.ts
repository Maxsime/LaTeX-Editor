import type {
  CreatedShareLink,
  MembersResponse,
  ProjectInvitesResponse,
  ReceivedInvitesResponse,
  SharedRole,
  ShareLinkPreview,
  ShareLinksResponse,
} from '@galley/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';
import { projectsKey } from './projects.js';

export const membersKey = (projectId: string) => ['project', projectId, 'members'] as const;
const projectInvitesKey = (projectId: string) => ['project', projectId, 'invites'] as const;
const linksKey = (projectId: string) => ['project', projectId, 'links'] as const;
export const receivedInvitesKey = ['invites'] as const;

/** Path of the page that joins a project through a share link. */
export function joinPath(token: string): string {
  return `/join/${token}`;
}

export function useMembers(projectId: string) {
  return useQuery({
    queryKey: membersKey(projectId),
    queryFn: () =>
      api<MembersResponse>('GET', `/api/projects/${projectId}/members`).then(
        (body) => body.members,
      ),
  });
}

/** Members, invitations and links of a project; only its owner may call the last two. */
export function useSharing(projectId: string, isOwner: boolean) {
  const base = `/api/projects/${projectId}`;
  const invites = useQuery({
    queryKey: projectInvitesKey(projectId),
    queryFn: () =>
      api<ProjectInvitesResponse>('GET', `${base}/invites`).then((body) => body.invites),
    enabled: isOwner,
  });
  const links = useQuery({
    queryKey: linksKey(projectId),
    queryFn: () => api<ShareLinksResponse>('GET', `${base}/links`).then((body) => body.links),
    enabled: isOwner,
  });
  return { invites, links };
}

/** Changes to a project's members, invitations and links; each refreshes the project's data. */
export function useSharingMutations(projectId: string) {
  const client = useQueryClient();
  const base = `/api/projects/${projectId}`;
  const refresh = () => client.invalidateQueries({ queryKey: ['project', projectId] });
  return {
    setRole: useMutation({
      mutationFn: ({ userId, role }: { userId: string; role: SharedRole }) =>
        api('PATCH', `${base}/members/${userId}`, { json: { role } }),
      onSettled: refresh,
    }),
    removeMember: useMutation({
      mutationFn: (userId: string) => api('DELETE', `${base}/members/${userId}`),
      onSettled: refresh,
    }),
    transfer: useMutation({
      mutationFn: (userId: string) => api('POST', `${base}/transfer`, { json: { userId } }),
      onSettled: () =>
        Promise.all([refresh(), client.invalidateQueries({ queryKey: projectsKey })]),
    }),
    invite: useMutation({
      mutationFn: (input: { identifier: string; role: SharedRole }) =>
        api<{ id: string }>('POST', `${base}/invites`, { json: input }),
      onSuccess: refresh,
    }),
    cancelInvite: useMutation({
      mutationFn: (inviteId: string) => api('DELETE', `${base}/invites/${inviteId}`),
      onSettled: refresh,
    }),
    createLink: useMutation({
      mutationFn: (input: { role: SharedRole; expiresInDays?: number }) =>
        api<CreatedShareLink>('POST', `${base}/links`, { json: input }),
      onSuccess: refresh,
    }),
    revokeLink: useMutation({
      mutationFn: (linkId: string) => api('DELETE', `${base}/links/${linkId}`),
      onSettled: refresh,
    }),
  };
}

/** Invitations waiting for the signed-in user. */
export function useReceivedInvites() {
  return useQuery({
    queryKey: receivedInvitesKey,
    queryFn: () => api<ReceivedInvitesResponse>('GET', '/api/invites').then((body) => body.invites),
  });
}

export function useAnswerInvite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) =>
      api<{ projectId: string } | undefined>(
        'POST',
        `/api/invites/${id}/${accept ? 'accept' : 'decline'}`,
      ),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: receivedInvitesKey }),
        client.invalidateQueries({ queryKey: projectsKey }),
      ]),
  });
}

export function useLinkPreview(token: string) {
  return useQuery({
    queryKey: ['link', token],
    queryFn: () => api<ShareLinkPreview>('GET', `/api/links/${token}`),
    retry: false,
  });
}

export function useJoinLink(token: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ projectId: string }>('POST', `/api/links/${token}/join`),
    onSuccess: () => client.invalidateQueries({ queryKey: projectsKey }),
  });
}
