import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePreview } from '../components/FilePreview.js';
import { FileTree, type TreeActions } from '../components/FileTree.js';
import { Button, ErrorAlert } from '../components/ui.js';
import { useProject, useTree, useTreeMutations, useUpdateProject } from '../lib/projects.js';
import { buildTree, flatten } from '../lib/tree.js';
import { fromFileList } from '../lib/upload.js';
import { useNotices } from '../stores/notices.js';
import { useTreeState } from '../stores/tree.js';

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
  const { open, selectedId } = useTreeState();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    open(projectId);
  }, [open, projectId]);

  const nodes = tree.data?.nodes ?? [];
  const roots = buildTree(nodes);
  const all = flatten(roots);
  const selected = nodes.find((node) => node.id === selectedId);
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

  if (project.error) return <ErrorAlert error={project.error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/projects" className="text-sm text-accent underline">
          ← {t('project.back')}
        </Link>
        <h1 className="mr-auto font-serif text-2xl font-semibold">{project.data?.name}</h1>
        <label className="flex items-center gap-2 text-sm">
          <span>{t('project.mainFile')}</span>
          <select
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
      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <FileTree
          nodes={nodes}
          roots={roots}
          mainFileId={project.data?.mainFileId ?? null}
          actions={actions}
          error={<ErrorAlert error={mutations.upload.error ?? tree.error} />}
          toolbar={(openFolderDialog) => (
            <div className="mb-2 flex flex-wrap gap-1">
              <Button onClick={openFolderDialog}>{t('project.newFolder')}</Button>
              <Button
                disabled={mutations.upload.isPending}
                onClick={() => fileInput.current?.click()}
              >
                {mutations.upload.isPending ? t('project.uploading') : t('project.uploadFiles')}
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
          )}
        />
        <section aria-live="polite" className="min-w-0">
          <FilePreview projectId={projectId} node={selected} />
        </section>
      </div>
    </div>
  );
}
