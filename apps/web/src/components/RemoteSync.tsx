import type { PullResponse, PushResponse, RemoteResponse } from '@galley/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRemote, useRemoteMutations } from '../lib/remote.js';
import { Button, ConfirmDialog, ErrorAlert, TextField, useFieldError } from './ui.js';

/** What the last pull or push did, in words. */
function Outcome({ result }: { result: PullResponse | PushResponse }) {
  const { t } = useTranslation();
  if (result.outcome === 'conflict') {
    return (
      <div role="status" className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">
        <p>{t('remote.outcome.conflict')}</p>
        <ul className="ml-4 list-disc font-mono text-xs">
          {result.paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (result.outcome === 'refused') {
    return (
      <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">
        {t(`remote.refused.${result.reason}`, { path: result.path ?? '' })}
      </p>
    );
  }
  return (
    <p role="status" className="rounded-md bg-slate-100 px-3 py-2">
      {t(`remote.outcome.${result.outcome}`)}
    </p>
  );
}

function RemoteForm({
  projectId,
  data,
  onDone,
}: {
  projectId: string;
  data: RemoteResponse;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { set } = useRemoteMutations(projectId);
  const fieldError = useFieldError(set.error);
  const existing = data.remote;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const text = (name: string) => {
          const value = form.get(name);
          return typeof value === 'string' ? value.trim() : '';
        };
        const token = text('token');
        set.mutate(
          { url: text('url'), branch: text('branch'), ...(token === '' ? {} : { token }) },
          { onSuccess: onDone },
        );
      }}
    >
      <TextField
        label={t('remote.url')}
        name="url"
        type="url"
        required
        defaultValue={existing?.url ?? ''}
        placeholder="https://github.com/compte/these"
        hint={t('remote.hosts', { hosts: data.allowedHosts.join(', ') })}
        error={fieldError('url')}
      />
      <TextField
        label={t('remote.branch')}
        name="branch"
        required
        defaultValue={existing?.branch ?? 'main'}
        error={fieldError('branch')}
      />
      <TextField
        label={t('remote.token')}
        name="token"
        type="password"
        autoComplete="off"
        required={existing === null}
        hint={
          existing === null
            ? t('remote.tokenHint')
            : t('remote.tokenKeep', { hint: existing.tokenHint })
        }
        error={fieldError('token')}
      />
      <ErrorAlert error={set.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={set.isPending}>
          {t('common.save')}
        </Button>
        {existing !== null && (
          <Button variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * Synchronisation with GitHub or GitLab (SPEC §3.5): the owner links a
 * repository and a branch with an access token; editors pull and push.
 */
export function RemoteSync({ projectId, isOwner }: { projectId: string; isOwner: boolean }) {
  const { t, i18n } = useTranslation();
  const remote = useRemote(projectId, true);
  const mutations = useRemoteMutations(projectId);
  const [editing, setEditing] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [result, setResult] = useState<PullResponse | PushResponse | null>(null);
  const data = remote.data;
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const busy = mutations.pull.isPending || mutations.push.isPending;

  return (
    <section
      aria-labelledby="remote-title"
      className="space-y-2 border-t border-slate-200 pt-3 text-sm"
    >
      <h3 id="remote-title" className="font-medium">
        {t('remote.title')}
      </h3>
      <ErrorAlert error={remote.error} />
      {data !== undefined && !data.available && (
        <p className="text-slate-600">{t('remote.unavailable')}</p>
      )}
      {data?.available === true && data.remote === null && !isOwner && (
        <p className="text-slate-600">{t('remote.none')}</p>
      )}
      {data?.available === true && isOwner && (data.remote === null || editing) && (
        <>
          {data.remote === null && <p className="text-slate-700">{t('remote.intro')}</p>}
          <RemoteForm
            projectId={projectId}
            data={data}
            onDone={() => {
              setEditing(false);
            }}
          />
        </>
      )}
      {data?.available === true && data.remote !== null && !editing && (
        <>
          <p>
            <span className="font-mono text-xs">{data.remote.url}</span>
            {' · '}
            {t('remote.onBranch', { branch: data.remote.branch })}
            {' · '}
            <span className="font-mono text-xs">…{data.remote.tokenHint}</span>
          </p>
          <p className="text-xs text-slate-600">
            {data.remote.lastSyncedAt === null
              ? t('remote.never')
              : t('remote.last', { date: date.format(new Date(data.remote.lastSyncedAt)) })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => {
                setResult(null);
                mutations.pull.mutate(undefined, { onSuccess: setResult });
              }}
            >
              {t('remote.pull')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setResult(null);
                mutations.push.mutate(undefined, { onSuccess: setResult });
              }}
            >
              {t('remote.push')}
            </Button>
            {isOwner && (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(true);
                  }}
                >
                  {t('remote.edit')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setUnlinking(true);
                  }}
                >
                  {t('remote.unlink')}
                </Button>
              </>
            )}
          </div>
          {busy && <p className="text-slate-600">{t('remote.working')}</p>}
          {result !== null && <Outcome result={result} />}
          <ErrorAlert error={mutations.pull.error ?? mutations.push.error} />
        </>
      )}
      <ConfirmDialog
        open={unlinking}
        onOpenChange={setUnlinking}
        title={t('remote.unlinkTitle')}
        description={t('remote.unlinkConfirm')}
        confirmLabel={t('remote.unlink')}
        pending={mutations.remove.isPending}
        onConfirm={() => {
          mutations.remove.mutate(undefined, {
            onSettled: () => {
              setUnlinking(false);
              setResult(null);
            },
          });
        }}
      />
    </section>
  );
}
