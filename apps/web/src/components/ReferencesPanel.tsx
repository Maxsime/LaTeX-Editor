import {
  hasRole,
  type ImportedEntry,
  type LookupSource,
  type ProjectRole,
  type TreeNode,
} from '@galley/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectIndex } from '../lib/editor.js';
import { useTreeMutations } from '../lib/projects.js';
import {
  filterReferences,
  joinEntries,
  useBibliographyImport,
  useWritingFeatures,
  useZoteroAccount,
  useZoteroItems,
} from '../lib/writing.js';
import { useEditor } from '../stores/editor.js';
import { Button, Dialog, ErrorAlert } from './ui.js';

interface ReferencesPanelProps {
  projectId: string;
  role: ProjectRole;
  nodes: readonly TreeNode[];
  paths: ReadonlyMap<string, string>;
}

type ImportTab = LookupSource | 'zotero';
const NEW_FILE = 'references.bib';
const input = 'rounded border border-slate-300 px-2 py-1 text-sm';

function ZoteroSearch({ onPick }: { onPick: (itemKeys: string[]) => void }) {
  const { t } = useTranslation();
  const account = useZoteroAccount();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const items = useZoteroItems(account.data?.connected === true ? submitted : null);
  if (account.data?.connected !== true) {
    return <p className="text-slate-600">{t('references.zotero.notConnected')}</p>;
  }
  return (
    <div className="space-y-2">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query);
        }}
      >
        <input
          type="search"
          aria-label={t('references.zotero.search')}
          placeholder={t('references.zotero.search')}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
          className={`${input} min-w-0 flex-1`}
        />
        <Button type="submit">{t('references.zotero.find')}</Button>
      </form>
      <ErrorAlert error={items.error} />
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {(items.data ?? []).map((item) => (
          <li key={item.key}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={chosen.has(item.key)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.currentTarget.checked) next.add(item.key);
                  else next.delete(item.key);
                  setChosen(next);
                }}
              />
              <span>
                {item.title}
                <span className="block text-xs text-slate-600">
                  {[item.authors.join(', '), item.year].filter(Boolean).join(' · ')}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <Button
        disabled={chosen.size === 0}
        onClick={() => {
          onPick([...chosen]);
        }}
      >
        {t('references.zotero.import', { count: chosen.size })}
      </Button>
    </div>
  );
}

function ImportDialog({
  projectId,
  open,
  onOpenChange,
  bibFiles,
  canCreate,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bibFiles: { id: string; path: string }[];
  canCreate: boolean;
}) {
  const { t } = useTranslation();
  const features = useWritingFeatures();
  const { lookup, zotero } = useBibliographyImport(projectId);
  const { upload } = useTreeMutations(projectId);
  const insert = useEditor((state) => state.insert);
  const [tab, setTab] = useState<ImportTab>('doi');
  const [query, setQuery] = useState('');
  const [keepKeys, setKeepKeys] = useState(false);
  const [entries, setEntries] = useState<ImportedEntry[]>([]);
  const [target, setTarget] = useState('');
  const tabs: ImportTab[] = ['doi', 'arxiv', 'isbn', 'bibtex'];
  if (features.data?.zotero === true) tabs.push('zotero');
  const chosenTarget = target === '' ? (bibFiles[0]?.id ?? (canCreate ? NEW_FILE : '')) : target;
  const reset = () => {
    setEntries([]);
    lookup.reset();
    zotero.reset();
  };
  const add = () => {
    const text = joinEntries(entries.map((entry) => entry.bibtex));
    const done = () => {
      reset();
      setQuery('');
      onOpenChange(false);
    };
    if (chosenTarget === NEW_FILE) {
      upload.mutate(
        {
          parentId: null,
          uploads: [
            { path: NEW_FILE, file: new File([`${text}\n`], NEW_FILE, { type: 'text/plain' }) },
          ],
        },
        { onSuccess: done },
      );
      return;
    }
    insert({ fileId: chosenTarget, text, at: 'end' });
    done();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={t('references.import.title')}
      wide
    >
      <div className="space-y-3 text-sm">
        <div role="tablist" className="flex flex-wrap gap-1">
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => {
                setTab(name);
                reset();
              }}
              className="rounded-md px-2 py-1 aria-selected:bg-slate-200 aria-selected:font-medium hover:bg-slate-100"
            >
              {t(`references.import.sources.${name}`)}
            </button>
          ))}
        </div>
        {tab === 'zotero' ? (
          <ZoteroSearch
            onPick={(itemKeys) => {
              zotero.mutate(itemKeys, { onSuccess: setEntries });
            }}
          />
        ) : (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              lookup.mutate({ source: tab, query, keepKeys }, { onSuccess: setEntries });
            }}
          >
            {tab === 'bibtex' ? (
              <>
                <textarea
                  aria-label={t('references.import.sources.bibtex')}
                  value={query}
                  rows={8}
                  placeholder="@article{…}"
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                  }}
                  className={`${input} w-full font-mono text-xs`}
                />
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={keepKeys}
                    onChange={(event) => {
                      setKeepKeys(event.currentTarget.checked);
                    }}
                  />
                  {t('references.import.keepKeys')}
                </label>
              </>
            ) : (
              <input
                aria-label={t(`references.import.sources.${tab}`)}
                placeholder={t(`references.import.placeholders.${tab}`)}
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                }}
                className={`${input} w-full`}
              />
            )}
            <Button type="submit" disabled={query.trim() === '' || lookup.isPending}>
              {lookup.isPending ? t('references.import.searching') : t('references.import.search')}
            </Button>
          </form>
        )}
        <ErrorAlert error={lookup.error ?? zotero.error ?? upload.error} />
        {entries.length > 0 && (
          <div className="space-y-2">
            <pre
              data-testid="import-preview"
              className="max-h-56 overflow-auto rounded bg-slate-50 p-2 font-mono text-xs"
            >
              {joinEntries(entries.map((entry) => entry.bibtex))}
            </pre>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2">
                {t('references.import.target')}
                <select
                  value={chosenTarget}
                  onChange={(event) => {
                    setTarget(event.currentTarget.value);
                  }}
                  className={input}
                >
                  {bibFiles.map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.path}
                    </option>
                  ))}
                  {canCreate && !bibFiles.some((file) => file.path === NEW_FILE) && (
                    <option value={NEW_FILE}>
                      {t('references.import.create', { name: NEW_FILE })}
                    </option>
                  )}
                </select>
              </label>
              <Button
                variant="primary"
                disabled={chosenTarget === '' || upload.isPending}
                onClick={add}
              >
                {t('references.import.add', { count: entries.length })}
              </Button>
            </div>
            {chosenTarget === NEW_FILE && (
              <p className="text-xs text-slate-600">{t('references.import.createHint')}</p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** The project's bibliography: search, citation, and import (SPEC §3.6). */
export function ReferencesPanel({ projectId, role, nodes, paths }: ReferencesPanelProps) {
  const { t } = useTranslation();
  const index = useProjectIndex(projectId);
  const { activeId, insert, revealAt } = useEditor();
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState<'all' | 'cited' | 'uncited'>('all');
  const [importing, setImporting] = useState(false);
  const canWrite = hasRole(role, 'reviewer');
  const activeNode = nodes.find((node) => node.id === activeId);
  const citeTarget =
    canWrite && activeNode?.kind === 'text' && /\.(tex|ltx)$/i.test(activeNode.name)
      ? activeNode.id
      : null;
  const bibFiles = nodes
    .filter((node) => node.kind === 'text' && node.name.toLowerCase().endsWith('.bib'))
    .map((node) => ({ id: node.id, path: paths.get(node.id) ?? node.name }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const rows = index.data ? filterReferences(index.data, query, only) : [];

  return (
    <div className="space-y-2 text-sm">
      <div className="flex gap-1">
        <input
          type="search"
          aria-label={t('references.search')}
          placeholder={t('references.search')}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
          className={`${input} min-w-0 flex-1`}
        />
        {canWrite && (
          <Button
            onClick={() => {
              setImporting(true);
            }}
          >
            {t('references.import.open')}
          </Button>
        )}
      </div>
      <select
        aria-label={t('references.filter.label')}
        value={only}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setOnly(value === 'cited' || value === 'uncited' ? value : 'all');
        }}
        className={`${input} w-full`}
      >
        <option value="all">{t('references.filter.all')}</option>
        <option value="cited">{t('references.filter.cited')}</option>
        <option value="uncited">{t('references.filter.uncited')}</option>
      </select>
      <ErrorAlert error={index.error} />
      {index.data && rows.length === 0 && (
        <p className="text-slate-600">
          {index.data.citations.length === 0 ? t('references.empty') : t('references.none')}
        </p>
      )}
      <ul className="space-y-1" aria-label={t('references.list')}>
        {rows.map((row) => (
          <li
            key={`${row.fileId}:${row.key}`}
            data-testid={`reference-${row.key}`}
            className="rounded border border-slate-200 p-2"
          >
            <div className="flex items-center gap-1">
              <span className="mr-auto truncate font-mono text-xs">{row.key}</span>
              {!row.cited && (
                <span className="rounded bg-slate-100 px-1 text-xs text-slate-600">
                  {t('references.uncited')}
                </span>
              )}
            </div>
            {row.title !== null && <p className="line-clamp-2">{row.title}</p>}
            <p className="text-xs text-slate-600">
              {[row.authors.join(', '), row.year].filter(Boolean).join(' · ')}
            </p>
            <div className="mt-1 flex gap-1">
              <Button
                variant="ghost"
                className="px-2 py-0.5 text-xs"
                disabled={citeTarget === null}
                title={citeTarget === null ? t('references.citeHint') : undefined}
                onClick={() => {
                  if (citeTarget !== null) {
                    insert({ fileId: citeTarget, text: `\\cite{${row.key}}`, at: 'cursor' });
                  }
                }}
              >
                {t('references.cite')}
              </Button>
              <Button
                variant="ghost"
                className="px-2 py-0.5 text-xs"
                onClick={() => {
                  revealAt({ fileId: row.fileId, line: row.line });
                }}
              >
                {t('references.show')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {canWrite && (
        <ImportDialog
          projectId={projectId}
          open={importing}
          onOpenChange={setImporting}
          bibFiles={bibFiles}
          canCreate={hasRole(role, 'editor')}
        />
      )}
    </div>
  );
}
