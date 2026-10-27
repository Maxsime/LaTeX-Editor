import {
  type CompileRequest,
  type CompileRun,
  type CompilerInfo,
  type Diagnostic,
  isFinalCompileStatus,
  type LatestCompileResponse,
} from '@galley/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCompileStore } from '../stores/compile.js';
import { api } from './api.js';

export const compileKey = (projectId: string) => ['project', projectId, 'compile'] as const;

/** URL of a file published by a compilation. */
export function outputUrl(projectId: string, compileId: string, name: string): string {
  const path = name.split('/').map(encodeURIComponent).join('/');
  return `/api/projects/${projectId}/compiles/${compileId}/output/${path}`;
}

/** Whether a compilation is still waiting for or using a worker. */
export function isPending(run: Pick<CompileRun, 'status'> | null | undefined): boolean {
  return run != null && !isFinalCompileStatus(run.status);
}

/** Diagnostics counted by level, for the toolbar and the log panel tabs. */
export function countLevels(
  diagnostics: readonly Diagnostic[],
): Record<Diagnostic['level'], number> {
  const counts = { error: 0, warning: 0, badbox: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.level] += 1;
  return counts;
}

/** Diagnostics grouped by project file, for the gutter markers of each editor. */
export function diagnosticsByFile(diagnostics: readonly Diagnostic[]): Map<string, Diagnostic[]> {
  const byFile = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.file === null || diagnostic.line === null) continue;
    const list = byFile.get(diagnostic.file) ?? [];
    list.push(diagnostic);
    byFile.set(diagnostic.file, list);
  }
  return byFile;
}

/** Keyboard shortcuts that compile: Ctrl+S and Ctrl+Enter (Cmd on macOS). */
export function isCompileShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  return event.key === 'Enter' || event.key.toLowerCase() === 's';
}

/** The project's latest compilation and its last PDF; polled while one is pending. */
export function useLatestCompile(projectId: string) {
  return useQuery({
    queryKey: compileKey(projectId),
    queryFn: ({ signal }) =>
      api<LatestCompileResponse>('GET', `/api/projects/${projectId}/compiles/latest`, { signal }),
    // Events bring updates; polling covers a dropped connection.
    refetchInterval: (query) => (isPending(query.state.data?.latest) ? 2000 : false),
  });
}

export function useCompilerInfo() {
  return useQuery({
    queryKey: ['compiler'],
    queryFn: ({ signal }) => api<CompilerInfo>('GET', '/api/compiler', { signal }),
    staleTime: 10 * 60_000,
  });
}

/**
 * Starts a compilation once the server holds every keystroke made so far, so
 * the PDF always reflects what the user sees.
 */
export function useCompile(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: Partial<CompileRequest>) => {
      await useCompileStore.getState().waitForSaved();
      return api<CompileRun>('POST', `/api/projects/${projectId}/compile`, { json: request });
    },
    onSuccess: (run) => {
      client.setQueryData<LatestCompileResponse>(compileKey(projectId), (previous) => ({
        latest: run,
        lastPdf: previous?.lastPdf ?? null,
      }));
    },
  });
}

export function useCancelCompile(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (compileId: string) =>
      api<CompileRun>('POST', `/api/projects/${projectId}/compiles/${compileId}/cancel`),
    onSettled: () => client.invalidateQueries({ queryKey: compileKey(projectId) }),
  });
}
