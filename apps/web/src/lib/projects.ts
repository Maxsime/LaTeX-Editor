import type {
  ImportProjectResponse,
  ProjectDetails,
  ProjectState,
  ProjectSummary,
  ProjectTemplate,
  ProjectTree,
  Tag,
  TreeNode,
  UpdateProjectRequest,
  UploadResponse,
} from '@galley/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDashboard } from '../stores/dashboard.js';
import { api } from './api.js';
import { batches, type PendingUpload, UPLOAD_BATCH, uploadForm } from './upload.js';

export const projectsKey = ['projects'] as const;
export const tagsKey = ['tags'] as const;
const projectKey = (id: string) => ['project', id] as const;
const treeKey = (id: string) => ['project', id, 'tree'] as const;

/** Project list for the current dashboard filters. */
export function useProjects() {
  const { state, search, sort, order, tagId } = useDashboard();
  return useQuery({
    queryKey: [...projectsKey, { state, search, sort, order, tagId }],
    queryFn: ({ signal }) =>
      api<{ projects: ProjectSummary[] }>('GET', '/api/projects', {
        query: { state, search, sort, order, tagId: tagId ?? undefined },
        signal,
      }).then((body) => body.projects),
    placeholderData: (previous) => previous,
  });
}

export function useTags() {
  return useQuery({
    queryKey: tagsKey,
    queryFn: () => api<{ tags: Tag[] }>('GET', '/api/tags').then((body) => body.tags),
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: projectKey(id),
    queryFn: () => api<ProjectDetails>('GET', `/api/projects/${id}`),
  });
}

export function useTree(id: string) {
  return useQuery({
    queryKey: treeKey(id),
    queryFn: () => api<ProjectTree>('GET', `/api/projects/${id}/tree`),
  });
}

function useInvalidate() {
  const client = useQueryClient();
  return (...keys: (readonly unknown[])[]) =>
    Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
}

export function useCreateProject() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { name: string; template: ProjectTemplate }) =>
      api<{ project: ProjectSummary }>('POST', '/api/projects', { json: input }),
    onSuccess: () => invalidate(projectsKey),
  });
}

export function useImportProject() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('archive', file, file.name);
      return api<ImportProjectResponse>('POST', '/api/projects/import', { form });
    },
    onSuccess: () => invalidate(projectsKey),
  });
}

export type BulkAction = 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge';

const bulkRequests: Record<BulkAction, (id: string) => Promise<unknown>> = {
  archive: (id) => api('POST', `/api/projects/${id}/archive`),
  unarchive: (id) => api('POST', `/api/projects/${id}/unarchive`),
  trash: (id) => api('DELETE', `/api/projects/${id}`),
  restore: (id) => api('POST', `/api/projects/${id}/restore`),
  purge: (id) => api('DELETE', `/api/projects/${id}/permanent`),
};

/** Actions available for projects in a given dashboard view. */
export function actionsFor(state: ProjectState): BulkAction[] {
  if (state === 'trashed') return ['restore', 'purge'];
  return state === 'archived' ? ['unarchive', 'trash'] : ['archive', 'trash'];
}

export function useBulkAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ action, ids }: { action: BulkAction; ids: readonly string[] }) => {
      for (const id of ids) await bulkRequests[action](id);
    },
    onSettled: () => invalidate(projectsKey),
  });
}

export function useTagMutations() {
  const invalidate = useInvalidate();
  const refresh = () => invalidate(tagsKey, projectsKey);
  return {
    create: useMutation({
      mutationFn: (input: { name: string; color: string }) =>
        api<{ tag: Tag }>('POST', '/api/tags', { json: input }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api('DELETE', `/api/tags/${id}`),
      onSuccess: refresh,
    }),
    apply: useMutation({
      mutationFn: ({ projectId, tagId, on }: { projectId: string; tagId: string; on: boolean }) =>
        api(on ? 'PUT' : 'DELETE', `/api/projects/${projectId}/tags/${tagId}`),
      onSuccess: refresh,
    }),
  };
}

export function useUpdateProject(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (change: UpdateProjectRequest) =>
      api<ProjectDetails>('PATCH', `/api/projects/${id}`, { json: change }),
    onSuccess: () => invalidate(projectKey(id), projectsKey),
  });
}

/** Mutations on the file tree; each one refreshes the tree and the project. */
export function useTreeMutations(projectId: string) {
  const invalidate = useInvalidate();
  const refresh = () => invalidate(projectKey(projectId));
  const base = `/api/projects/${projectId}`;
  return {
    createFolder: useMutation({
      mutationFn: (input: { parentId: string | null; name: string }) =>
        api<{ node: TreeNode }>('POST', `${base}/folders`, { json: input }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, ...change }: { id: string; name?: string; parentId?: string | null }) =>
        api<{ node: TreeNode }>('PATCH', `${base}/files/${id}`, { json: change }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api('DELETE', `${base}/files/${id}`),
      onSuccess: refresh,
    }),
    upload: useMutation({
      mutationFn: async ({
        parentId,
        uploads,
      }: {
        parentId: string | null;
        uploads: readonly PendingUpload[];
      }) => {
        const warnings: UploadResponse['warnings'] = [];
        for (const batch of batches(uploads, UPLOAD_BATCH)) {
          const response = await api<UploadResponse>('POST', `${base}/files`, {
            form: uploadForm(parentId, batch),
          });
          warnings.push(...response.warnings);
        }
        return warnings;
      },
      onSettled: refresh,
    }),
  };
}
