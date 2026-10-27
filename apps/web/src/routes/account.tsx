import type { AccessToken } from '@galley/shared';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AiSection } from '../components/AccountAi.js';
import { DictionarySection, ZoteroSection } from '../components/AccountWriting.js';
import { Button, ConfirmDialog, ErrorAlert, TextField, useFieldError } from '../components/ui.js';
import { useAccessTokenMutations, useAccessTokens } from '../lib/tokens.js';

const EXPIRY_DAYS = [0, 30, 90, 365] as const;

function CreatedToken({ token }: { token: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <div className="space-y-1 rounded-md bg-slate-50 p-3">
      <label htmlFor={id} className="block text-sm font-medium">
        {t('account.tokens.created')}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={token}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs"
        />
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(token).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? t('share.links.copied') : t('share.links.copy')}
        </Button>
      </div>
      <p className="text-xs text-slate-600">{t('account.tokens.once')}</p>
    </div>
  );
}

/** The user's own settings: Git access tokens, Zotero library, personal dictionary. */
export function AccountPage() {
  const { t, i18n } = useTranslation();
  const tokens = useAccessTokens();
  const mutations = useAccessTokenMutations();
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AccessToken | null>(null);
  const fieldError = useFieldError(mutations.create.error);
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' });

  return (
    <div className="space-y-6">
      <h1 className="font-serif text-2xl font-semibold">{t('account.title')}</h1>
      <section aria-labelledby="tokens-title" className="max-w-2xl space-y-3">
        <h2 id="tokens-title" className="text-lg font-semibold">
          {t('account.tokens.title')}
        </h2>
        <p className="text-sm text-slate-700">{t('account.tokens.intro')}</p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const value = data.get('name');
            const name = typeof value === 'string' ? value.trim() : '';
            const days = Number(data.get('expiry'));
            const form = event.currentTarget;
            mutations.create.mutate(days > 0 ? { name, expiresInDays: days } : { name }, {
              onSuccess: ({ token }) => {
                setCreated(token);
                form.reset();
              },
            });
          }}
        >
          <div className="min-w-[14rem] flex-1">
            <TextField
              label={t('account.tokens.name')}
              name="name"
              required
              maxLength={100}
              placeholder={t('account.tokens.namePlaceholder')}
              error={fieldError('name')}
            />
          </div>
          <label className="space-y-1 text-sm">
            <span className="block font-medium">{t('account.tokens.expiry')}</span>
            <select
              name="expiry"
              defaultValue="90"
              className="rounded-md border border-slate-300 px-2 py-2 text-sm"
            >
              {EXPIRY_DAYS.map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? t('share.links.never') : t('share.links.days', { count: days })}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="primary" disabled={mutations.create.isPending}>
            {t('account.tokens.create')}
          </Button>
        </form>
        {created !== null && <CreatedToken token={created} />}
        <ErrorAlert error={tokens.error ?? mutations.revoke.error} />
        {tokens.data?.length === 0 && (
          <p className="text-sm text-slate-600">{t('account.tokens.none')}</p>
        )}
        {(tokens.data ?? []).length > 0 && (
          <ul
            className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm"
            aria-label={t('account.tokens.list')}
          >
            {(tokens.data ?? []).map((token) => (
              <li key={token.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="mr-auto">
                  <span className="font-medium">{token.name}</span>
                  <span className="ml-2 font-mono text-xs text-slate-600">…{token.hint}</span>
                  <span className="block text-xs text-slate-600">
                    {t('account.tokens.details', {
                      created: date.format(new Date(token.createdAt)),
                      expires:
                        token.expiresAt === null
                          ? t('share.links.noExpiry')
                          : t('share.links.expires', {
                              date: date.format(new Date(token.expiresAt)),
                            }),
                      used:
                        token.lastUsedAt === null
                          ? t('account.tokens.neverUsed')
                          : date.format(new Date(token.lastUsedAt)),
                    })}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setRevoking(token);
                  }}
                >
                  {t('share.links.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ZoteroSection />
      <AiSection />
      <DictionarySection />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t('account.tokens.revokeTitle')}
        description={t('account.tokens.confirmRevoke', { name: revoking?.name ?? '' })}
        confirmLabel={t('share.links.revoke')}
        pending={mutations.revoke.isPending}
        onConfirm={() => {
          if (revoking) {
            mutations.revoke.mutate(revoking.id, {
              onSettled: () => {
                setRevoking(null);
              },
            });
          }
        }}
      />
    </div>
  );
}
