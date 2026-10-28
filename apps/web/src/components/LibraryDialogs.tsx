import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { nameFromUrl, useLibraryFiles, useOtherProjects, useSourceTree } from '../lib/library.js';
import { buildTree, flatten } from '../lib/tree.js';
import { Button, Dialog, ErrorAlert, TextField } from './ui.js';

const selectClass = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal';

/** Select of the person's other active projects. */
function ProjectSelect({
  projectId,
  open,
  value,
  onChange,
}: {
  projectId: string;
  open: boolean;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const projects = useOtherProjects(projectId, open);
  return (
    <label className="block space-y-1 text-sm font-medium">
      <span>{t('library.sourceProject')}</span>
      <select
        className={selectClass}
        value={value ?? ''}
        onChange={(event) => {
          onChange(event.currentTarget.value || null);
        }}
      >
        <option value="">{t('library.chooseProject')}</option>
        {(projects.data ?? []).map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Files and folders of a source project, depth first, with their paths. */
function useSourceItems(sourceId: string | null) {
  const tree = useSourceTree(sourceId);
  const items = useMemo(() => flatten(buildTree(tree.data?.nodes ?? [])), [tree.data]);
  return { items, error: tree.error };
}

/**
 * Adds a linked file: a copy of a public URL or of another project's file,
 * read-only here and refreshed on request (SPEC §3.1).
 */
export function LinkFileDialog({
  projectId,
  parentId,
  open,
  onOpenChange,
}: {
  projectId: string;
  parentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { link } = useLibraryFiles(projectId);
  const [kind, setKind] = useState<'url' | 'project'>('url');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [fileId, setFileId] = useState('');
  const source = useSourceItems(kind === 'project' ? sourceId : null);
  const files = source.items.filter((item) => item.kind !== 'folder' && !item.link);

  const close = () => {
    onOpenChange(false);
    setUrl('');
    setName('');
    setSourceId(null);
    setFileId('');
    link.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t('library.link.title')}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          link.mutate(
            {
              parentId,
              name: name.trim(),
              link:
                kind === 'url'
                  ? { kind: 'url', url: url.trim() }
                  : { kind: 'project', projectId: sourceId ?? '', fileId },
            },
            { onSuccess: close },
          );
        }}
      >
        <fieldset className="flex gap-4 text-sm">
          <legend className="sr-only">{t('library.link.kind')}</legend>
          {(['url', 'project'] as const).map((value) => (
            <label key={value} className="flex items-center gap-1">
              <input
                type="radio"
                name="kind"
                checked={kind === value}
                onChange={() => {
                  setKind(value);
                }}
              />
              {t(`library.link.kinds.${value}`)}
            </label>
          ))}
        </fieldset>
        {kind === 'url' ? (
          <TextField
            label={t('library.link.url')}
            hint={t('library.link.urlHint')}
            type="url"
            value={url}
            maxLength={2000}
            required
            onChange={(event) => {
              setUrl(event.currentTarget.value);
            }}
            onBlur={() => {
              if (name === '') setName(nameFromUrl(url));
            }}
          />
        ) : (
          <>
            <ProjectSelect
              projectId={projectId}
              open={open}
              value={sourceId}
              onChange={(id) => {
                setSourceId(id);
                setFileId('');
              }}
            />
            <label className="block space-y-1 text-sm font-medium">
              <span>{t('library.link.file')}</span>
              <select
                className={selectClass}
                value={fileId}
                required
                disabled={sourceId === null}
                onChange={(event) => {
                  const id = event.currentTarget.value;
                  setFileId(id);
                  const chosen = files.find((item) => item.id === id);
                  if (name === '' && chosen) setName(chosen.name);
                }}
              >
                <option value="">{t('library.link.chooseFile')}</option>
                {files.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.path}
                  </option>
                ))}
              </select>
            </label>
            <ErrorAlert error={source.error} />
          </>
        )}
        <TextField
          label={t('library.link.name')}
          value={name}
          maxLength={255}
          required
          onChange={(event) => {
            setName(event.currentTarget.value);
          }}
        />
        <ErrorAlert error={link.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={link.isPending}>
            {link.isPending ? t('library.link.fetching') : t('library.link.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Copies files and folders of another project into this one. */
export function CopyFilesDialog({
  projectId,
  targetFolderId,
  open,
  onOpenChange,
}: {
  projectId: string;
  targetFolderId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { copy } = useLibraryFiles(projectId);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const source = useSourceItems(sourceId);

  const close = () => {
    onOpenChange(false);
    setSourceId(null);
    setChosen(new Set());
    copy.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t('library.copy.title')}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (sourceId === null || chosen.size === 0) return;
          copy.mutate(
            { sourceProjectId: sourceId, fileIds: [...chosen], targetFolderId },
            { onSuccess: close },
          );
        }}
      >
        <ProjectSelect
          projectId={projectId}
          open={open}
          value={sourceId}
          onChange={(id) => {
            setSourceId(id);
            setChosen(new Set());
          }}
        />
        {sourceId !== null && (
          <fieldset>
            <legend className="mb-1 text-sm font-medium">{t('library.copy.items')}</legend>
            <ul className="max-h-64 space-y-0.5 overflow-auto rounded-md border border-slate-200 p-2 text-sm">
              {source.items.map((item) => (
                <li key={item.id} style={{ paddingLeft: `${String(item.depth)}rem` }}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={chosen.has(item.id)}
                      onChange={(event) => {
                        const next = new Set(chosen);
                        if (event.currentTarget.checked) next.add(item.id);
                        else next.delete(item.id);
                        setChosen(next);
                      }}
                    />
                    <span>{item.kind === 'folder' ? `${item.name}/` : item.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-slate-600">{t('library.copy.help')}</p>
          </fieldset>
        )}
        <ErrorAlert error={source.error ?? copy.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={copy.isPending || chosen.size === 0}>
            {t('library.copy.submit', { count: chosen.size })}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
