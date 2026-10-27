import {
  type Diagnostic,
  hasRole,
  type ProjectEventMessage,
  type ProjectRole,
  presenceUserOf,
  type TreeNode,
} from '@galley/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePreview } from '../components/FilePreview.js';
import { compileKey } from '../lib/compile.js';
import { indexKey, outlineKey, useProjectIndex } from '../lib/editor.js';
import { projectQuery, useUpdateProject } from '../lib/projects.js';
import { addMessage, useThreads } from '../lib/review.js';
import { useSession } from '../lib/session.js';
import { useCompileStore } from '../stores/compile.js';
import { FONT_SIZES, useEditor, usePreferences } from '../stores/editor.js';
import { useNotices } from '../stores/notices.js';
import { usePresence } from '../stores/presence.js';
import { useReview } from '../stores/review.js';
import { CodeEditor } from './CodeEditor.js';
import type { CompletionSources } from './completion.js';
import type { ProjectLintContext } from './lint.js';
import { ProjectConnection, type SyncStatus } from './connection.js';

interface EditorAreaProps {
  projectId: string;
  nodes: readonly TreeNode[];
  /** Project-relative path of each node. */
  paths: ReadonlyMap<string, string>;
  role: ProjectRole;
  /** The owner asked for every editor's changes to be suggestions. */
  trackChanges: boolean;
  /** Diagnostics of the last compilation, by project-relative path. */
  diagnostics: ReadonlyMap<string, readonly Diagnostic[]>;
}

const NO_DIAGNOSTICS: readonly Diagnostic[] = [];

/** Longest wait for the server to acknowledge edits before compiling anyway. */
const SAVE_WAIT_MS = 5000;

const STATUS_STYLE: Record<SyncStatus, string> = {
  connecting: 'bg-slate-400',
  saved: 'bg-emerald-600',
  saving: 'bg-amber-500',
  offline: 'bg-red-600',
  denied: 'bg-red-800',
};

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function Preferences() {
  const { t } = useTranslation();
  const { theme, fontSize, lineWrapping, setTheme, setFontSize, setLineWrapping } =
    usePreferences();
  return (
    <div className="ml-auto flex items-center gap-2 px-2 text-xs">
      <label className="flex items-center gap-1">
        <span>{t('editor.preferences.theme')}</span>
        <select
          value={theme}
          onChange={(event) => {
            setTheme(event.currentTarget.value === 'dark' ? 'dark' : 'light');
          }}
          className="rounded border border-slate-300 px-1 py-0.5"
        >
          <option value="light">{t('editor.preferences.light')}</option>
          <option value="dark">{t('editor.preferences.dark')}</option>
        </select>
      </label>
      <label className="flex items-center gap-1">
        <span>{t('editor.preferences.fontSize')}</span>
        <select
          value={fontSize}
          onChange={(event) => {
            setFontSize(Number(event.currentTarget.value));
          }}
          className="rounded border border-slate-300 px-1 py-0.5"
        >
          {FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={lineWrapping}
          onChange={(event) => {
            setLineWrapping(event.currentTarget.checked);
          }}
        />
        <span>{t('editor.preferences.wrap')}</span>
      </label>
    </div>
  );
}

/**
 * Tabs and editors of a project. Owns the project's collab connection, which
 * also carries project events and presence: tree changes refresh the file
 * list, deletion of the project or loss of access returns to the dashboard.
 */
export default function EditorArea({
  projectId,
  nodes,
  paths,
  role,
  trackChanges,
  diagnostics,
}: EditorAreaProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const navigate = useNavigate();
  const { tabs, activeId, status, openTab, closeTab, setStatus, keepTabs } = useEditor();
  const editCount = useEditor((state) => state.editCount);
  const index = useProjectIndex(projectId);
  const { user } = useSession();
  const onEventRef = useRef<(event: ProjectEventMessage) => void>(() => undefined);
  const checkAccessRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const leave = (flash: 'accessLost' | 'projectDeleted') => {
      useNotices.getState().setFlash(flash);
      void navigate({ to: '/projects' });
    };
    // Our own role changed: reload it, and leave if access is gone.
    checkAccessRef.current = () => {
      client.query({ ...projectQuery(projectId), staleTime: 0 }).then(
        () => client.invalidateQueries({ queryKey: ['project', projectId] }),
        () => {
          leave('accessLost');
        },
      );
    };
    onEventRef.current = (event) => {
      if (event.type === 'project.deleted') {
        leave('projectDeleted');
        return;
      }
      if (event.type === 'members.changed' && event.userId !== null && event.userId === user?.id) {
        checkAccessRef.current();
        return;
      }
      if (event.type === 'chat.message') {
        addMessage(client, projectId, event.message);
        return;
      }
      if (event.type === 'compile.updated') {
        void client.invalidateQueries({ queryKey: compileKey(projectId) });
        return;
      }
      void client.invalidateQueries({ queryKey: ['project', projectId] });
    };
  }, [client, navigate, projectId, user]);

  const [reloaded, setReloaded] = useState(false);
  // The parent remounts this component per project, so one connection per instance suffices.
  const [connection] = useState(
    () =>
      new ProjectConnection(
        projectId,
        onEventRef,
        setStatus,
        usePresence.getState().setParticipants,
        (fileId) => {
          useReview.getState().noteReload(fileId);
          setReloaded(true);
        },
      ),
  );
  useEffect(() => {
    useReview.getState().setConnection(connection);
    return () => {
      useReview.getState().setConnection(null);
    };
  }, [connection]);

  // Anchors of resolved threads are not drawn.
  const threads = useThreads(projectId);
  useEffect(() => {
    useReview
      .getState()
      .setOpenThreads(
        new Set(
          (threads.data ?? [])
            .filter((thread) => thread.resolvedAt === null)
            .map((thread) => thread.id),
        ),
      );
  }, [threads.data]);

  const personal = useReview((state) => state.suggesting);
  const updateProject = useUpdateProject(projectId);
  // Reviewers can only suggest; editors when the owner or they themselves ask for it.
  const readOnly = !hasRole(role, 'reviewer');
  const suggesting = role === 'reviewer' || (hasRole(role, 'editor') && (trackChanges || personal));
  useEffect(
    () =>
      connection.onChannelDenied(() => {
        checkAccessRef.current();
      }),
    [connection],
  );
  useEffect(() => {
    if (user) connection.setUser(presenceUserOf(user.id, user.displayName));
  }, [connection, user]);
  useEffect(() => {
    connection.setActiveFile(activeId);
  }, [connection, activeId]);

  useEffect(() => {
    connection.start();
    const warn = (event: BeforeUnloadEvent) => {
      // Edits made offline live only in this tab until the connection comes back.
      if (connection.hasPendingChanges()) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    useCompileStore.getState().setWaitForSaved(async () => {
      const deadline = Date.now() + SAVE_WAIT_MS;
      while (connection.hasPendingChanges() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
    return () => {
      usePresence.getState().setParticipants([]);
      useCompileStore.getState().setWaitForSaved(() => Promise.resolve());
      window.removeEventListener('beforeunload', warn);
      connection.stop();
    };
  }, [connection]);

  // Close tabs whose file was deleted, by this user or another.
  useEffect(() => {
    if (nodes.length > 0) keepTabs(new Set(nodes.map((node) => node.id)));
  }, [nodes, keepTabs]);

  // Refresh the outline after a typing pause, and the completion index less often.
  useEffect(() => {
    if (editCount === 0) return;
    const outline = setTimeout(() => {
      void client.invalidateQueries({ queryKey: outlineKey(projectId) });
    }, 1500);
    const definitions = setTimeout(() => {
      void client.invalidateQueries({ queryKey: indexKey(projectId) });
    }, 5000);
    return () => {
      clearTimeout(outline);
      clearTimeout(definitions);
    };
  }, [editCount, client, projectId]);

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const sourcesRef = useRef<CompletionSources>({
    commands: [],
    environments: [],
    paths: [],
    directory: '',
    labels: [],
    citations: [],
  });
  useEffect(() => {
    sourcesRef.current = {
      commands: index.data?.commands ?? [],
      environments: (index.data?.environments ?? []).map((environment) => environment.name),
      paths: nodes
        .filter((node) => node.kind !== 'folder')
        .map((node) => paths.get(node.id) ?? node.name),
      directory: dirname(activeId === null ? '' : (paths.get(activeId) ?? '')),
      // The edited file's labels come from its live text, not from the index.
      labels: (index.data?.labels ?? [])
        .filter((label) => label.fileId !== activeId)
        .map((label) => label.name),
      citations: index.data?.citations ?? [],
    };
  }, [index.data, nodes, paths, activeId]);
  const completion = useCallback(() => sourcesRef.current, []);

  const lintRef = useRef<ProjectLintContext | null>(null);
  useEffect(() => {
    if (index.data === undefined) {
      lintRef.current = null;
      return;
    }
    // The edited file's own labels and \bibitem keys are read from its live text.
    const labelCounts = new Map<string, number>();
    for (const label of index.data.labels) {
      if (label.fileId !== activeId)
        labelCounts.set(label.name, (labelCounts.get(label.name) ?? 0) + 1);
    }
    const citationKeys = new Set(
      index.data.citations
        .filter((entry) => entry.type !== 'bibitem' || entry.fileId !== activeId)
        .map((entry) => entry.key),
    );
    lintRef.current = { labelCounts, citationKeys };
  }, [index.data, activeId]);
  const lintContext = useCallback(() => lintRef.current, []);

  if (tabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-600">
        {t('editor.empty')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center border-b border-slate-200 bg-slate-50">
        <div role="tablist" aria-label={t('editor.tabs')} className="flex min-w-0 overflow-x-auto">
          {tabs.map((id) => {
            const node = byId.get(id);
            const tabStatus = status[id];
            return (
              <div
                key={id}
                className={`flex items-center gap-1 border-r border-slate-200 px-2 py-1 text-sm ${
                  id === activeId ? 'bg-white font-medium' : 'text-slate-600'
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={id === activeId}
                  title={paths.get(id)}
                  onClick={() => {
                    openTab(id);
                  }}
                  className="flex items-center gap-1.5"
                >
                  {node?.kind === 'text' && (
                    <span
                      data-testid={`status-${id}`}
                      data-status={tabStatus ?? 'connecting'}
                      title={t(`editor.status.${tabStatus ?? 'connecting'}`)}
                      className={`inline-block size-2 rounded-full ${STATUS_STYLE[tabStatus ?? 'connecting']}`}
                    />
                  )}
                  {node?.name ?? '…'}
                </button>
                <button
                  type="button"
                  aria-label={t('editor.closeTab', { name: node?.name ?? '' })}
                  onClick={() => {
                    closeTab(id);
                  }}
                  className="rounded px-1 text-slate-500 hover:bg-slate-200"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {!readOnly && (
          <label
            className={`ml-2 flex items-center gap-1 rounded px-2 py-0.5 text-xs ${suggesting ? 'bg-emerald-100 text-emerald-900' : ''}`}
            title={t(
              role === 'reviewer'
                ? 'review.mode.reviewer'
                : trackChanges
                  ? 'review.mode.project'
                  : 'review.mode.help',
            )}
          >
            <input
              type="checkbox"
              checked={suggesting}
              // Imposed on reviewers by their role, and on editors by the owner's setting.
              disabled={role === 'reviewer' || trackChanges}
              onChange={(event) => {
                useReview.getState().setSuggesting(event.currentTarget.checked);
              }}
            />
            <span>{t('review.mode.label')}</span>
          </label>
        )}
        {role === 'owner' && (
          <label
            className="flex items-center gap-1 px-1 text-xs"
            title={t('review.mode.everyoneHelp')}
          >
            <input
              type="checkbox"
              checked={trackChanges}
              disabled={updateProject.isPending}
              onChange={(event) => {
                updateProject.mutate({ trackChanges: event.currentTarget.checked });
              }}
            />
            <span>{t('review.mode.everyone')}</span>
          </label>
        )}
        <Preferences />
      </div>
      {reloaded && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-3 py-1 text-sm text-amber-900"
        >
          {t('review.reloaded')}
          <button
            type="button"
            className="ml-auto underline"
            onClick={() => {
              setReloaded(false);
            }}
          >
            {t('common.close')}
          </button>
        </div>
      )}
      {activeId !== null && status[activeId] !== undefined && (
        <p className="sr-only" aria-live="polite">
          {t(`editor.status.${status[activeId]}`)}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {tabs.map((id) => {
          const node = byId.get(id);
          if (!node) return null;
          if (node.kind !== 'text') {
            return (
              <div key={id} className={id === activeId ? 'h-full overflow-auto p-4' : 'hidden'}>
                <FilePreview projectId={projectId} node={node} />
              </div>
            );
          }
          return (
            <CodeEditor
              key={id}
              connection={connection}
              fileId={id}
              fileName={node.name}
              active={id === activeId}
              readOnly={readOnly}
              suggesting={suggesting}
              userId={user?.id ?? ''}
              completion={completion}
              lintContext={lintContext}
              diagnostics={diagnostics.get(paths.get(id) ?? '') ?? NO_DIAGNOSTICS}
            />
          );
        })}
      </div>
    </div>
  );
}
