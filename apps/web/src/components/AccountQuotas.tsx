import { useTranslation } from 'react-i18next';
import { formatBytes, minutesOf, useMyQuotas, usedShare } from '../lib/admin.js';
import { ErrorAlert } from './ui.js';

function Meter({ label, detail, share }: { label: string; detail: string; share: number | null }) {
  return (
    <div className="space-y-1 text-sm">
      <div className="flex justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className="text-slate-700">{detail}</span>
      </div>
      {share !== null && (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
          className="h-2 overflow-hidden rounded bg-slate-100"
        >
          <div
            className={share >= 0.9 ? 'h-full bg-red-600' : 'h-full bg-accent'}
            style={{ width: `${String(share * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** What the person used of their storage and compile time (SPEC §3.9). */
export function QuotaSection() {
  const { t, i18n } = useTranslation();
  const quotas = useMyQuotas();
  if (!quotas.data) return <ErrorAlert error={quotas.error} />;
  const { storage, compile } = quotas.data;
  const bytes = (value: number) => formatBytes(value, i18n.language);
  const since = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'long' }).format(
    new Date(compile.since),
  );
  return (
    <section aria-labelledby="quotas-title" className="max-w-2xl space-y-3" data-testid="quotas">
      <h2 id="quotas-title" className="text-lg font-semibold">
        {t('account.quotas.title')}
      </h2>
      <Meter
        label={t('account.quotas.storage')}
        detail={
          storage.limitBytes === null
            ? t('account.quotas.unlimited', { used: bytes(storage.usedBytes) })
            : t('account.quotas.of', {
                used: bytes(storage.usedBytes),
                limit: bytes(storage.limitBytes),
              })
        }
        share={usedShare(storage.usedBytes, storage.limitBytes)}
      />
      <Meter
        label={t('account.quotas.compile', { since })}
        detail={
          compile.limitSeconds === null
            ? t('account.quotas.minutesUnlimited', { count: minutesOf(compile.usedSeconds) })
            : t('account.quotas.minutesOf', {
                used: minutesOf(compile.usedSeconds),
                count: minutesOf(compile.limitSeconds),
              })
        }
        share={usedShare(compile.usedSeconds, compile.limitSeconds)}
      />
      <p className="text-xs text-slate-600">{t('account.quotas.note')}</p>
    </section>
  );
}
