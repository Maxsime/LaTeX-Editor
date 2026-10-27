import { hasRole } from '@galley/shared';
import { ToggleGroup } from 'radix-ui';
import { Link, useParams } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CompilePane } from '../components/CompilePane.js';
import { FileTree, type TreeActions } from '../components/FileTree.js';
import { HistoryDialog } from '../components/HistoryDialog.js';
import { OutlinePanel } from '../components/OutlinePanel.js';
import { PresenceBadges } from '../components/PresenceBadges.js';
import { ReferencesPanel } from '../components/ReferencesPanel.js';
import { WordsPanel } from '../components/WordsPanel.js';
import { SearchPanel } from '../components/SearchPanel.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { ShareDialog } from '../components/ShareDialog.js';
import { Button, ErrorAlert, NameDialog } from '../components/ui.js';
import { ApiRequestError } from '../lib/api.js';
import { diagnosticsByFile, isPending, useLatestCompile } from '../lib/compile.js';
import { useProject, useTree, useTreeMutations, useUpdateProject } from '../lib/projects.js';
import { buildTree, flatten } from '../lib/tree.js';
import { fromFileList } from '../lib/upload.js';
import { useCompilePreferences, type ViewMode } from '../stores/compile.js';
import { useEditor } from '../stores/editor.js';
import { useNotices } from '../stores/notices.js';
import { useReview } from '../stores/review.js';
import { useTreeState } from '../stores/tree.js';

// CodeMirror, Yjs and the collab client load with the first project opened, not the dashboard.
const EditorArea = lazy(() => import('../editor/EditorArea.js'));
// Needs Yjs as well, for the suggestions of the open file.
const ReviewPanel = lazy(() => import('../components/ReviewPanel.js'));

type Panel = 'files' | 'outline' | 'search' | 'references' | 'words' | 'review' | 'chat';
const PANELS: readonly Panel[] = [
  'files',
  'outline',
  'search',
  'references',
  'words',
  'review',
  'chat',
];
const VIEW_MODES: readonly ViewMode[] = ['editor', 'both', 'pdf'];

const GRID: Record<ViewMode, string> = {
  both: 'md:grid-cols-[16rem_minmax(0,1fr)_minmax(0,1fr)]',
  editor: 'md:grid-cols-[16rem_minmax(0,1fr)]',
  pdf: 'md:grid-cols-[16rem_minmax(0,1fr)]',
};

function Warnings({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const warnings = useNotices((state) => state.warnings[projectId]);
  const dismiss = useNotices((state) => state.dismiss);
  if (!warnings || warnings.length === 0) return null;
  return (
    <div
      role="status"
      className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-950"
    >
      <ul className="list-disc pl-5">
        {warnings.map((warning) => (
          <li key={`${warning.code}:${warning.path}`}>
            {t(`warnings.${warning.code}`, { path: warning.path })}
          </li>
        ))}
      </ul>
      <Button
        variant="ghost"
        onClick={() => {
          dismiss(projectId);
        }}
      >
        {t('common.close')}
      </Button>
    </div>
  );
}

export function ProjectPage() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const project = useProject(projectId);
  const tree = useTree(projectId);
  const mutations = useTreeMutations(projectId);
  const updateProject = useUpdateProject(projectId);
  const setWarnings = useNotices((state) => state.setWarnings);
  const { open, selectedId, select } = useTreeState();
  const { openProject, openTab } = useEditor();
  const activeId = useEditor((state) => state.activeId);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // Opened from a mention on the dashboard: start on the review panel.
  const [panel, setPanel] = useState<Panel>(() =>
    useReview.getState().showReview ? 'review' : 'files',
  );
  const [newFile, setNewFile] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const compiles = useLatestCompile(projectId);
  const { viewMode, setViewMode } = useCompilePreferences();

  useEffect(() => {
    open(projectId);
    openProject(projectId);
  }, [open, openProject, projectId]);

  const nodes = useMemo(() => tree.data?.nodes ?? [], [tree.data]);
  const roots = useMemo(() => buildTree(nodes), [nodes]);
  const all = useMemo(() => flatten(roots), [roots]);
  const paths = useMemo(() => new Map(all.map((item) => [item.id, item.path])), [all]);
  // Commenting a selection (Ctrl+Alt+M) opens the review panel to type the comment.
  useEffect(() => {
    useReview.getState().setShowReview(false);
    return useReview.subscribe((state, previous) => {
      if (state.pending !== null && previous.pending === null) setPanel('review');
    });
  }, []);
  const selected = nodes.find((node) => node.id === selectedId);
  const canEdit = project.data !== undefined && hasRole(project.data.role, 'editor');
  const fileIds = useMemo(() => new Map(all.map((item) => [item.path, item.id])), [all]);
  const latest = compiles.data?.latest ?? null;
  const lastPdf = compiles.data?.lastPdf ?? null;
  // Markers come from the last finished compilation, kept while a new one runs.
  const shownRun = latest !== null && !isPending(latest) ? latest : lastPdf;
  const chktexDisabled = project.data?.chktexDisabled;
  // chktex warnings join the markers; a rule turned off since the compilation disappears at once.
  const diagnostics = useMemo(
    () =>
      diagnosticsByFile([
        ...(shownRun?.diagnostics ?? []),
        ...(shownRun?.lint ?? []).filter(
          (warning) => !(chktexDisabled ?? []).includes(Number(warning.context)),
        ),
      ]),
    [shownRun, chktexDisabled],
  );

  // Selecting a file in the tree opens it; switching tabs selects it in the tree.
  useEffect(() => {
    if (selected !== undefined && selected.kind !== 'folder') openTab(selected.id);
  }, [selected, openTab]);
  useEffect(() => {
    if (activeId !== null) select(activeId);
  }, [activeId, select]);
  const uploadTarget = selected?.kind === 'folder' ? selected.id : (selected?.parentId ?? null);
  const texFiles = all.filter(
    (item) => item.kind === 'text' && item.name.toLowerCase().endsWith('.tex'),
  );

  const actions: TreeActions = {
    rename: (id, name) => mutations.update.mutateAsync({ id, name }),
    move: (id, parentId) => mutations.update.mutateAsync({ id, parentId }),
    remove: (id) => mutations.remove.mutateAsync(id),
    createFolder: (parentId, name) => mutations.createFolder.mutateAsync({ parentId, name }),
    upload: (parentId, uploads) => {
      mutations.upload.mutate(
        { parentId, uploads },
        {
          onSuccess: (warnings) => {
            setWarnings(projectId, warnings);
          },
        },
      );
    },
  };

  const createFile = (name: string) => {
    const taken = nodes.some((node) => node.parentId === uploadTarget && node.name === name);
    if (taken) return Promise.reject(new ApiRequestError(409, 'CONFLICT'));
    return mutations.upload
      .mutateAsync({
        parentId: uploadTarget,
        uploads: [{ path: name, file: new File([], name, { type: 'text/plain' }) }],
      })
      .then(() => {
        setNewFile(false);
      });
  };
  const [newFileError, setNewFileError] = useState<unknown>(null);

  if (project.error) return <ErrorAlert error={project.error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/projects" className="text-sm text-accent underline">
          ← {t('project.back')}
        </Link>
        <h1 className="font-serif text-2xl font-semibold">{project.data?.name}</h1>
        {project.data && project.data.role !== 'owner' && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
            {t(`roles.${project.data.role}`)}
          </span>
        )}
        <div className="mr-auto" />
        <PresenceBadges paths={paths} />
        <Button
          onClick={() => {
            setSharing(true);
          }}
        >
          {t('share.open')}
        </Button>
        <Button
          onClick={() => {
            setHistoryOpen(true);
          }}
        >
          {t('history.open')}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <span>{t('project.mainFile')}</span>
          <select
            disabled={!canEdit}
            value={project.data?.mainFileId ?? ''}
            onChange={(event) => {
              updateProject.mutate({ mainFileId: event.currentTarget.value || null });
            }}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            <option value="">{t('project.mainFileNone')}</option>
            {texFiles.map((file) => (
              <option key={file.id} value={file.id}>
                {file.path}
              </option>
            ))}
          </select>
        </label>
        <ToggleGroup.Root
          type="single"
          value={viewMode}
          aria-label={t('compile.view.label')}
          onValueChange={(value) => {
            const mode = VIEW_MODES.find((item) => item === value);
            if (mode) setViewMode(mode);
          }}
          className="flex rounded-md border border-slate-300 text-sm"
        >
          {VIEW_MODES.map((mode) => (
            <ToggleGroup.Item
              key={mode}
              value={mode}
              className="px-2 py-1 data-[state=on]:bg-slate-200 data-[state=on]:font-medium"
            >
              {t(`compile.view.${mode}`)}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
        <a
          href={`/api/projects/${projectId}/export`}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
          download
        >
          {t('project.export')}
        </a>
      </div>
      <Warnings projectId={projectId} />
      <ErrorAlert error={updateProject.error} />
      <div className={`grid h-[calc(100vh-11rem)] min-h-[28rem] gap-3 ${GRID[viewMode]}`}>
        <aside className="flex min-h-0 flex-col">
          <div role="tablist" aria-label={t('editor.panels')} className="mb-2 flex flex-wrap gap-1">
            {PANELS.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={panel === name}
                onClick={() => {
                  setPanel(name);
                }}
                className="rounded-md px-2 py-1 text-sm aria-selected:bg-slate-200 aria-selected:font-medium hover:bg-slate-100"
              >
                {t(`editor.panel.${name}`)}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {panel === 'files' && (
              <FileTree
                nodes={nodes}
                roots={roots}
                mainFileId={project.data?.mainFileId ?? null}
                actions={actions}
                readOnly={!canEdit}
                error={<ErrorAlert error={mutations.upload.error ?? tree.error} />}
                toolbar={(openFolderDialog) =>
                  canEdit && (
                    <div className="mb-2 flex flex-wrap gap-1">
                      <Button
                        onClick={() => {
                          setNewFileError(null);
                          setNewFile(true);
                        }}
                      >
                        {t('project.newFile')}
                      </Button>
                      <Button onClick={openFolderDialog}>{t('project.newFolder')}</Button>
                      <Button
                        disabled={mutations.upload.isPending}
                        onClick={() => fileInput.current?.click()}
                      >
                        {mutations.upload.isPending
                          ? t('project.uploading')
                          : t('project.uploadFiles')}
                      </Button>
                      <Button
                        disabled={mutations.upload.isPending}
                        onClick={() => folderInput.current?.click()}
                      >
                        {t('project.uploadFolder')}
                      </Button>
                      {[fileInput, folderInput].map((ref) => (
                        <input
                          key={ref === fileInput ? 'files' : 'folder'}
                          ref={ref}
                          type="file"
                          multiple
                          className="sr-only"
                          tabIndex={-1}
                          aria-hidden
                          data-testid={ref === fileInput ? 'upload-files' : 'upload-folder'}
                          {...(ref === folderInput ? { webkitdirectory: '' } : {})}
                          onChange={(event) => {
                            const uploads = fromFileList(event.currentTarget.files ?? []);
                            event.currentTarget.value = '';
                            if (uploads.length > 0) actions.upload(uploadTarget, uploads);
                          }}
                        />
                      ))}
                    </div>
                  )
                }
              />
            )}
            {panel === 'outline' && <OutlinePanel projectId={projectId} />}
            {panel === 'search' && <SearchPanel projectId={projectId} canEdit={canEdit} />}
            {panel === 'references' && project.data && (
              <ReferencesPanel
                projectId={projectId}
                role={project.data.role}
                nodes={nodes}
                paths={paths}
              />
            )}
            {panel === 'words' && <WordsPanel count={shownRun?.wordCount ?? null} />}
            {panel === 'review' && project.data && (
              <Suspense fallback={<p className="text-slate-600">{t('common.loading')}</p>}>
                <ReviewPanel projectId={projectId} role={project.data.role} names={paths} />
              </Suspense>
            )}
            {panel === 'chat' && <ChatPanel projectId={projectId} />}
          </div>
        </aside>
        <section
          className={`min-h-0 min-w-0 overflow-hidden rounded-md border border-slate-200 ${viewMode === 'pdf' ? 'hidden' : ''}`}
        >
          <Suspense fallback={<p className="p-4 text-slate-600">{t('common.loading')}</p>}>
            {project.data && (
              <EditorArea
                key={projectId}
                projectId={projectId}
                nodes={nodes}
                paths={paths}
                role={project.data.role}
                trackChanges={project.data.trackChanges}
                diagnostics={diagnostics}
                chktexDisabled={project.data.chktexDisabled}
                mainFileId={project.data.mainFileId}
              />
            )}
          </Suspense>
        </section>
        <section
          aria-label={t('compile.pane')}
          className={`min-h-0 min-w-0 overflow-hidden rounded-md border border-slate-200 ${viewMode === 'editor' ? 'hidden' : ''}`}
        >
          {project.data && (
            <CompilePane
              project={project.data}
              latest={latest}
              lastPdf={lastPdf}
              loaded={compiles.isSuccess}
              canEdit={canEdit}
              fileIds={fileIds}
            />
          )}
        </section>
      </div>
      {project.data && (
        <ShareDialog project={project.data} open={sharing} onOpenChange={setSharing} />
      )}
      <HistoryDialog
        projectId={projectId}
        canEdit={canEdit}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      />
      <NameDialog
        open={newFile}
        onOpenChange={setNewFile}
        title={t('project.newFile')}
        label={t('project.fileName')}
        submitLabel={t('common.create')}
        error={newFileError}
        pending={mutations.upload.isPending}
        onSubmit={(name) => {
          createFile(name).catch((error: unknown) => {
            setNewFileError(error);
          });
        }}
      />
    </div>
  );
}
