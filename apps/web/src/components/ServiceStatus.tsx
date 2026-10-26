import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchApiHealth } from '../lib/health.js';

const dependencyNames = ['postgres', 'valkey', 'storage'] as const;

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        ok ? 'bg-emerald-100 text-emerald-900' : 'bg-red-100 text-red-900'
      }`}
    >
      {label}
    </span>
  );
}

export function ServiceStatus() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['health', 'api'],
    queryFn: ({ signal }) => fetchApiHealth(signal),
    refetchInterval: 15_000,
  });

  return (
    <section aria-labelledby="status-title" className="rounded-lg border border-slate-200 p-5">
      <h2 id="status-title" className="mb-3 text-lg font-semibold">
        {t('home.status.title')}
      </h2>
      <div
        role="status"
        aria-live="polite"
        data-testid="api-status"
        data-state={data?.kind ?? 'checking'}
      >
        {data === undefined && <p className="text-slate-600">{t('home.status.checking')}</p>}
        {data?.kind === 'unreachable' && <Badge ok={false} label={t('home.status.unreachable')} />}
        {data !== undefined && data.kind !== 'unreachable' && (
          <ul className="space-y-2">
            {dependencyNames.map((name) => {
              const ok = data.health.checks?.[name]?.status === 'ok';
              return (
                <li key={name} className="flex items-center justify-between gap-4">
                  <span>{t(`dependencies.${name}`)}</span>
                  <Badge ok={ok} label={ok ? t('home.status.ok') : t('home.status.error')} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {data !== undefined && data.kind !== 'unreachable' && (
        <p className="mt-4 text-xs text-slate-500">
          {t('home.version', { version: data.health.version })}
        </p>
      )}
    </section>
  );
}
