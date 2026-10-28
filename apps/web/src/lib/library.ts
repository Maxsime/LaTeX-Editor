import {
  type CopyFilesRequest,
  type CreateLinkedFileRequest,
  type ProjectSummary,
  type ProjectTemplate,
  type ProjectTree,
  projectTemplate,
  type SaveTemplateRequest,
  type TemplateSummary,
  type TexmfResponse,
  type TreeNode,
  type UpdateTemplateRequest,
} from '@galley/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';
import { projectsKey } from './projects.js';

export const templatesKey = ['templates'] as const;
const treeKey = (id: string) => ['project', id, 'tree'] as const;

/** Saved templates a person may start from: theirs and the instance's. */
export function useTemplates() {
  return useQuery({
    queryKey: templatesKey,
    queryFn: () =>
      api<{ templates: TemplateSummary[] }>('GET', '/api/templates').then((body) => body.templates),
  });
}

export function useSaveTemplate(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveTemplateRequest) =>
      api<{ id: string }>('POST', `/api/projects/${projectId}/template`, { json: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: templatesKey }),
  });
}

export function useTemplateMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: templatesKey });
  return {
    update: useMutation({
      mutationFn: ({ id, ...changes }: UpdateTemplateRequest & { id: string }) =>
        api('PATCH', `/api/templates/${id}`, { json: changes }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api('DELETE', `/api/templates/${id}`),
      onSuccess: refresh,
    }),
  };
}

export function useDuplicateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<{ project: ProjectSummary }>('POST', `/api/projects/${id}/duplicate`, {
        json: { name },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: projectsKey }),
  });
}

/** The personal texmf tree, created by the server on first request. */
export function useOpenTexmf() {
  return useMutation({
    mutationFn: () => api<TexmfResponse>('GET', '/api/me/texmf'),
  });
}

/** Copies, links and link refreshes of one project's files. */
export function useLibraryFiles(projectId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: treeKey(projectId) });
  return {
    copy: useMutation({
      mutationFn: (input: CopyFilesRequest) =>
        api('POST', `/api/projects/${projectId}/files/copy`, { json: input }),
      onSuccess: refresh,
    }),
    link: useMutation({
      mutationFn: (input: CreateLinkedFileRequest) =>
        api<{ node: TreeNode }>('POST', `/api/projects/${projectId}/files/link`, {
          json: input,
        }),
      onSuccess: refresh,
    }),
    refreshLink: useMutation({
      mutationFn: (fileId: string) =>
        api<{ node: TreeNode }>('POST', `/api/projects/${projectId}/files/${fileId}/refresh`),
      onSuccess: refresh,
    }),
    unlink: useMutation({
      mutationFn: (fileId: string) =>
        api<{ node: TreeNode }>('POST', `/api/projects/${projectId}/files/${fileId}/unlink`),
      onSuccess: refresh,
    }),
  };
}

/**
 * Active projects other than `currentId`, by name, to pick a source from.
 * Loaded only while a dialog needs them.
 */
export function useOtherProjects(currentId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...projectsKey, 'choices'],
    queryFn: ({ signal }) =>
      api<{ projects: ProjectSummary[] }>('GET', '/api/projects', {
        query: { state: 'active', sort: 'name', order: 'asc' },
        signal,
      }).then((body) => body.projects),
    enabled,
    select: (projects) => projects.filter((project) => project.id !== currentId),
  });
}

/** Tree of a source project, once one is chosen. */
export function useSourceTree(projectId: string | null) {
  return useQuery({
    queryKey: treeKey(projectId ?? ''),
    queryFn: () => api<ProjectTree>('GET', `/api/projects/${projectId ?? ''}/tree`),
    enabled: projectId !== null,
  });
}

/** Suggests a file name for a link: the last segment of the URL path. */
export function nameFromUrl(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter((part) => part !== '');
    return decodeURIComponent(segments.at(-1) ?? '');
  } catch {
    return '';
  }
}

/** Default name of a duplicate, in the interface language. */
export function copyName(name: string, suffix: string): string {
  const candidate = `${name} (${suffix})`;
  return candidate.length <= 150 ? candidate : candidate.slice(0, 150);
}

/** What a new project starts from: a built-in template or a saved one. */
export type TemplateChoice = { template: ProjectTemplate } | { templateId: string };

/**
 * Reads the value of the template select: a built-in template name, or
 * `saved:<id>` for a template saved from a project.
 */
export function templateChoice(value: string): TemplateChoice {
  if (value.startsWith('saved:')) return { templateId: value.slice('saved:'.length) };
  const parsed = projectTemplate.safeParse(value);
  return { template: parsed.success ? parsed.data : 'blank' };
}
