import type { CompareResponse, SnapshotSummary } from '@galley/shared';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  foldDiff,
  useCompare,
  useHistory,
  useHistoryMutations,
  useTextChange,
} from '../lib/history.js';
import { cloneUrl } from '../lib/tokens.js';
import { Button, ConfirmDialog, Dialog, ErrorAlert, NameDialog } from './ui.js';

type Change = CompareResponse['changes'][number];

const STATUS_STYLE: Record<Change['status'], string> = {
  added: 'bg-emerald-100 text-emerald-900',
  removed: 'bg-red-100 text-red-900',
  modified: 'bg-amber-100 text-amber-900',
};

function useDateTime() {
  const { i18n } = useTranslation();
  return useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.resolvedLanguage],
  );
}

function VersionTitle({ snapshot }: { snapshot: SnapshotSummary }) {
  const { t } = useTranslation();
  return <>{snapshot.label ?? t(`history.kind.${snapshot.kind}`)}</>;
}

function Diff({
  projectId,
  versionId,
  change,
}: {
  projectId: string;
  versionId: string;
  change: Change;
}) {
  const { t } = useTranslation();
  const diff = useTextChange(projectId, {
    from: versionId,
    to: 'current',
    fromPath: change.status === 'added' ? null : change.path,
    toPath: change.status === 'removed' ? null : change.path,
  });
  if (diff.isPending) return <p className="text-sm text-slate-600">{t('common.loading')}</p>;
  if (diff.error) return <ErrorAlert error={diff.error} />;
  const lines = foldDiff(diff.data ?? []);
  return (
    <pre
      aria-label={t('history.diff', { path: change.path })}
      className="max-h-96 overflow-auto rounded-md border border-slate-200 font-mono text-xs leading-5"
    >
      {lines.map((line, index) =>
        line.kind === 'folded' ? (
          <div key={index} className="bg-slate-50 px-2 text-slate-500 italic">
            {t('history.unchangedLines', { count: line.count })}
          </div>
        ) : (
          <div
            key={index}
            data-kind={line.kind}
            className={
              line.kind === 'added'
                ? 'bg-emerald-50 text-emerald-950'
                : line.kind === 'removed'
                  ? 'bg-red-50 text-red-950'
                  : ''
            }
          >
            <span className="inline-block w-10 pr-2 text-right text-slate-400 select-none">
              {line.line}
            </span>
            <span className="inline-block w-4 select-none" aria-hidden>
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
            </span>
            <span className="sr-only">
              {line.kind === 'same' ? '' : t(`history.line.${line.kind}`)}
            </span>
            {line.text}
          </div>
        ),
      )}
    </pre>
  );
}

function VersionDetails({
  projectId,
  snapshot,
  canEdit,
  onRestored,
}: {
  projectId: string;
  snapshot: SnapshotSummary;
  canEdit: boolean;
  onRestored: () => void;
}) {
  const { t } = useTranslation();
  const changes = useCompare(projectId, snapshot.id);
  const mutations = useHistoryMutations(projectId);
  const [shown, setShown] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<{ path?: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const dateTime = useDateTime();

  return (
    <section aria-labelledby="version-title" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="version-title" className="mr-auto font-semibold">
          <VersionTitle snapshot={snapshot} />
          <span className="ml-2 text-sm font-normal text-slate-600">
            {dateTime.format(new Date(snapshot.createdAt))}
          </span>
        </h3>
        {canEdit && (
          <>
            <Button
              onClick={() => {
                setRenaming(true);
              }}
            >
              {snapshot.label === null ? t('history.name') : t('history.rename')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setRestoring({});
              }}
            >
              {t('history.restoreAll')}
            </Button>
          </>
        )}
        <a
          href={`/api/projects/${projectId}/history/${snapshot.id}/archive`}
          download
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
          {t('history.download')}
        </a>
      </div>
      <ErrorAlert error={changes.error ?? mutations.restore.error} />
      {changes.data?.length === 0 && (
        <p className="text-sm text-slate-600">{t('history.sameAsCurrent')}</p>
      )}
      {(changes.data ?? []).length > 0 && (
        <>
          <h4 className="text-sm font-medium">{t('history.changesSince')}</h4>
          <ul className="space-y-2 text-sm" aria-label={t('history.changesSince')}>
            {(changes.data ?? []).map((change) => (
              <li key={change.path} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[change.status]}`}>
                    {t(`history.status.${change.status}`)}
                  </span>
                  <span className="mr-auto font-mono text-xs break-all">{change.path}</span>
                  {change.text && (
                    <Button
                      variant="ghost"
                      aria-expanded={shown === change.path}
                      onClick={() => {
                        setShown(shown === change.path ? null : change.path);
                      }}
                    >
                      {shown === change.path ? t('history.hideDiff') : t('history.showDiff')}
                    </Button>
                  )}
                  {canEdit && change.status !== 'added' && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setRestoring({ path: change.path });
                      }}
                    >
                      {t('history.restoreFile')}
                    </Button>
                  )}
                </div>
                {shown === change.path && (
                  <Diff projectId={projectId} versionId={snapshot.id} change={change} />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => {
          if (!open) setRestoring(null);
        }}
        title={restoring?.path === undefined ? t('history.restoreAll') : t('history.restoreFile')}
        description={
          restoring?.path === undefined
            ? t('history.confirmRestoreAll')
            : t('history.confirmRestoreFile', { path: restoring.path })
        }
        confirmLabel={t('history.restore')}
        pending={mutations.restore.isPending}
        onConfirm={() => {
          if (restoring === null) return;
          mutations.restore.mutate(
            { id: snapshot.id, ...restoring },
            {
              onSuccess: onRestored,
              onSettled: () => {
                setRestoring(null);
              },
            },
          );
        }}
      />
      <NameDialog
        key={snapshot.id}
        open={renaming}
        onOpenChange={setRenaming}
        title={snapshot.label === null ? t('history.name') : t('history.rename')}
        label={t('history.label')}
        initialValue={snapshot.label ?? ''}
        submitLabel={t('common.save')}
        error={mutations.rename.error}
        pending={mutations.rename.isPending}
        onSubmit={(label) => {
          mutations.rename.mutate(
            { id: snapshot.id, label },
            {
              onSuccess: () => {
                setRenaming(false);
              },
            },
          );
        }}
      />
    </section>
  );
}

function GitAccess({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const id = useId();
  const url = cloneUrl(projectId);
  return (
    <section className="space-y-1 border-t border-slate-200 pt-3 text-sm">
      <label htmlFor={id} className="block font-medium">
        {t('history.git.title')}
      </label>
      <input
        id={id}
        readOnly
        value={`git clone ${url}`}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        className="w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-xs"
      />
      <p className="text-xs text-slate-600">
        {t('history.git.hint')}{' '}
        <Link to="/account" className="underline">
          {t('history.git.tokens')}
        </Link>
      </p>
    </section>
  );
}

/**
 * History of a project (SPEC §3.5): versions, what changed since each, and
 * restoration of a file or of the whole project. Restoring never removes a
 * version: the replaced state is recorded first.
 */
export function HistoryDialog({
  projectId,
  canEdit,
  open,
  onOpenChange,
}: {
  projectId: string;
  canEdit: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const history = useHistory(projectId, open);
  const mutations = useHistoryMutations(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const dateTime = useDateTime();
  const snapshots = useMemo(
    () => (history.data?.pages ?? []).flatMap((page) => page.snapshots),
    [history.data],
  );
  const selected = snapshots.find((snapshot) => snapshot.id === selectedId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('history.title')} large>
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm text-slate-700">{t('history.intro')}</p>
        {canEdit && (
          <Button
            onClick={() => {
              setNaming(true);
            }}
          >
            {t('history.nameCurrent')}
          </Button>
        )}
      </div>
      <ErrorAlert error={history.error} />
      <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="space-y-2">
          {history.isSuccess && snapshots.length === 0 && (
            <p className="text-sm text-slate-600">{t('history.empty')}</p>
          )}
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto" aria-label={t('history.versions')}>
            {snapshots.map((snapshot) => (
              <li key={snapshot.id}>
                <button
                  type="button"
                  aria-current={snapshot.id === selectedId ? 'true' : undefined}
                  onClick={() => {
                    setSelectedId(snapshot.id);
                  }}
                  className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 aria-[current]:bg-slate-200"
                >
                  <span className={`block ${snapshot.label === null ? '' : 'font-semibold'}`}>
                    <VersionTitle snapshot={snapshot} />
                  </span>
                  <span className="block text-xs text-slate-600">
                    {dateTime.format(new Date(snapshot.createdAt))}
                    {snapshot.authors.length > 0 &&
                      ` · ${snapshot.authors.map((author) => author.displayName).join(', ')}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {history.hasNextPage && (
            <Button
              disabled={history.isFetchingNextPage}
              onClick={() => {
                void history.fetchNextPage();
              }}
            >
              {t('history.more')}
            </Button>
          )}
        </div>
        {selected === null ? (
          <p className="text-sm text-slate-600">{t('history.pick')}</p>
        ) : (
          <VersionDetails
            projectId={projectId}
            snapshot={selected}
            canEdit={canEdit}
            onRestored={() => {
              setSelectedId(null);
            }}
          />
        )}
      </div>
      <GitAccess projectId={projectId} />
      <NameDialog
        open={naming}
        onOpenChange={setNaming}
        title={t('history.nameCurrent')}
        label={t('history.label')}
        submitLabel={t('common.save')}
        error={mutations.name.error}
        pending={mutations.name.isPending}
        onSubmit={(label) => {
          mutations.name.mutate(label, {
            onSuccess: ({ snapshot }) => {
              setNaming(false);
              setSelectedId(snapshot.id);
            },
          });
        }}
      />
    </Dialog>
  );
}
