import type {
  CompareResponse,
  HistoryResponse,
  RestoreResponse,
  SnapshotSummary,
} from '@galley/shared';
import { diffLines } from 'diff';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError } from './api.js';

// Under the project's key, so that project events (history.changed) refresh them.
const historyKey = (projectId: string) => ['project', projectId, 'history'] as const;

/** A version to read: a snapshot id, or `current` for the live project. */
export type VersionRef = string;

/** URL of a file's content in a version of the project. */
export function versionContentUrl(projectId: string, version: VersionRef, path: string): string {
  return `/api/projects/${projectId}/history/${version}/content?path=${encodeURIComponent(path)}`;
}

/** Snapshots of a project, newest first, one page of 50 at a time. */
export function useHistory(projectId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: historyKey(projectId),
    queryFn: ({ pageParam }) =>
      api<HistoryResponse>('GET', `/api/projects/${projectId}/history`, {
        query: { before: pageParam ?? undefined },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
  });
}

/** Files changed between a snapshot and another version, the live project by default. */
export function useCompare(projectId: string, from: string | null, to: VersionRef = 'current') {
  return useQuery({
    queryKey: [...historyKey(projectId), 'compare', from, to],
    queryFn: () =>
      api<CompareResponse>('GET', `/api/projects/${projectId}/history/compare`, {
        query: { from: from ?? undefined, to },
      }).then((body) => body.changes),
    enabled: from !== null,
  });
}

/** Text of a file in a version; empty when the file does not exist there. */
async function versionText(projectId: string, version: VersionRef, path: string | null) {
  if (path === null) return '';
  const response = await fetch(versionContentUrl(projectId, version, path), {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new ApiRequestError(response.status, 'NOT_FOUND');
  return response.text();
}

/** Both sides of a changed text file, for a line diff. */
export function useTextChange(
  projectId: string,
  change: { from: string; to: VersionRef; fromPath: string | null; toPath: string | null } | null,
) {
  return useQuery({
    queryKey: [...historyKey(projectId), 'text', change],
    queryFn: async () => {
      if (change === null) return null;
      const [before, after] = await Promise.all([
        versionText(projectId, change.from, change.fromPath),
        versionText(projectId, change.to, change.toPath),
      ]);
      return lineDiff(before, after);
    },
    enabled: change !== null,
  });
}

/** One line of a diff as shown to the user. */
export interface DiffLine {
  kind: 'added' | 'removed' | 'same';
  text: string;
  /** Line number on the old side, or on the new side for an added line. */
  line: number;
}

/**
 * Line-by-line comparison of two texts. Long unchanged stretches are kept:
 * the view folds them.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const part of diffLines(before, after)) {
    const texts = part.value.replace(/\n$/, '').split('\n');
    for (const text of texts) {
      if (part.added) {
        lines.push({ kind: 'added', text, line: newLine });
        newLine += 1;
      } else if (part.removed) {
        lines.push({ kind: 'removed', text, line: oldLine });
        oldLine += 1;
      } else {
        lines.push({ kind: 'same', text, line: oldLine });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return lines;
}

/** Unchanged lines kept around each change; longer unchanged runs are folded. */
const CONTEXT = 3;

/** A diff with the unchanged lines far from any change folded into counts. */
export type FoldedDiff = (DiffLine | { kind: 'folded'; count: number })[];

export function foldDiff(lines: readonly DiffLine[]): FoldedDiff {
  const near = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let offset = -CONTEXT; offset <= CONTEXT; offset += 1) near.add(index + offset);
  });
  const folded: FoldedDiff = [];
  let hidden = 0;
  lines.forEach((line, index) => {
    if (line.kind === 'same' && !near.has(index)) {
      hidden += 1;
      return;
    }
    if (hidden > 0) folded.push({ kind: 'folded', count: hidden });
    hidden = 0;
    folded.push(line);
  });
  if (hidden > 0) folded.push({ kind: 'folded', count: hidden });
  return folded;
}

/** Naming, renaming and restoring versions. */
export function useHistoryMutations(projectId: string) {
  const client = useQueryClient();
  const base = `/api/projects/${projectId}/history`;
  const refresh = () => client.invalidateQueries({ queryKey: ['project', projectId] });
  return {
    name: useMutation({
      mutationFn: (label: string) =>
        api<{ snapshot: SnapshotSummary }>('POST', base, { json: { label } }),
      onSuccess: refresh,
    }),
    rename: useMutation({
      mutationFn: ({ id, label }: { id: string; label: string | null }) =>
        api<{ snapshot: SnapshotSummary }>('PATCH', `${base}/${id}`, { json: { label } }),
      onSuccess: refresh,
    }),
    restore: useMutation({
      mutationFn: ({ id, path }: { id: string; path?: string }) =>
        api<RestoreResponse>('POST', `${base}/${id}/restore`, {
          json: path === undefined ? {} : { path },
        }),
      onSuccess: refresh,
    }),
  };
}
