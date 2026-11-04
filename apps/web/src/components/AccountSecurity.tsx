import { type AccountSession, PASSWORD_MIN_LENGTH } from '@galley/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  describeUserAgent,
  useAccountSecurityMutations,
  useAccountSessions,
} from '../lib/account-security.js';
import { Button, ErrorAlert, TextField, useFieldError } from './ui.js';

function PasswordForm() {
  const { t } = useTranslation();
  const { changePassword } = useAccountSecurityMutations();
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState(false);
  const fieldError = useFieldError(changePassword.error);
  return (
    <form
      className="max-w-sm space-y-3"
      aria-labelledby="password-title"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const read = (name: string) => {
          const value = data.get(name);
          return typeof value === 'string' ? value : '';
        };
        const newPassword = read('newPassword');
        setDone(false);
        if (newPassword !== read('confirmPassword')) {
          setMismatch(true);
          return;
        }
        setMismatch(false);
        changePassword.mutate(
          { currentPassword: read('currentPassword'), newPassword },
          {
            onSuccess: () => {
              form.reset();
              setDone(true);
            },
          },
        );
      }}
    >
      <h3 id="password-title" className="font-medium">
        {t('account.security.password.title')}
      </h3>
      <p className="text-sm text-slate-700">{t('account.security.password.intro')}</p>
      <TextField
        label={t('account.security.password.current')}
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
        error={fieldError('currentPassword')}
      />
      <TextField
        label={t('account.security.password.new')}
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        hint={t('account.security.password.newHint', { min: PASSWORD_MIN_LENGTH })}
        error={fieldError('newPassword')}
      />
      <TextField
        label={t('account.security.password.confirm')}
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
        error={mismatch ? t('account.security.password.mismatch') : undefined}
      />
      <ErrorAlert error={fieldError('newPassword') ? null : changePassword.error} />
      {done && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {t('account.security.password.done')}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={changePassword.isPending}>
        {t('account.security.password.submit')}
      </Button>
    </form>
  );
}

function SessionName({ session }: { session: AccountSession }) {
  const { t } = useTranslation();
  const { browser, os } = describeUserAgent(session.userAgent);
  if (browser === null && os === null) return <>{t('account.security.sessions.unknown')}</>;
  if (browser === null || os === null) return <>{browser ?? os}</>;
  return <>{t('account.security.sessions.browserOn', { browser, os })}</>;
}

function SessionList() {
  const { t, i18n } = useTranslation();
  const sessions = useAccountSessions();
  const { revoke, revokeOthers } = useAccountSecurityMutations();
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const list = sessions.data ?? [];
  const others = list.filter((session) => !session.current);
  return (
    <div className="space-y-3">
      <h3 id="sessions-title" className="font-medium">
        {t('account.security.sessions.title')}
      </h3>
      <p className="text-sm text-slate-700">{t('account.security.sessions.intro')}</p>
      <ErrorAlert error={sessions.error ?? revoke.error ?? revokeOthers.error} />
      {list.length > 0 && (
        <ul
          aria-labelledby="sessions-title"
          className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm"
        >
          {list.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="mr-auto">
                <span className="font-medium">
                  <SessionName session={session} />
                </span>
                {session.current && (
                  <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-900">
                    {t('account.security.sessions.current')}
                  </span>
                )}
                <span className="block text-xs text-slate-600">
                  {t('account.security.sessions.details', {
                    created: date.format(new Date(session.createdAt)),
                    seen: date.format(new Date(session.lastSeenAt)),
                  })}
                </span>
              </span>
              {!session.current && (
                <Button
                  variant="ghost"
                  disabled={revoke.isPending}
                  onClick={() => {
                    revoke.mutate(session);
                  }}
                >
                  {t('account.security.sessions.revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {sessions.data !== undefined &&
        (others.length === 0 ? (
          <p className="text-sm text-slate-600">{t('account.security.sessions.none')}</p>
        ) : (
          <Button
            variant="danger"
            disabled={revokeOthers.isPending}
            onClick={() => {
              revokeOthers.mutate();
            }}
          >
            {t('account.security.sessions.revokeOthers')}
          </Button>
        ))}
    </div>
  );
}

/** Password change and signed-in browsers of the account. */
export function SecuritySection() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="security-title" className="max-w-2xl space-y-4">
      <h2 id="security-title" className="text-lg font-semibold">
        {t('account.security.title')}
      </h2>
      <PasswordForm />
      <SessionList />
    </section>
  );
}
