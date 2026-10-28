import {
  ADMIN_USERS_PAGE,
  type AdminUser,
  type AiProvider,
  aiProvider,
  aiProviders,
  type RegistrationMode,
  registrationMode,
} from '@galley/shared';
import { Tabs } from 'radix-ui';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, ErrorAlert, TextField, useFieldError } from '../components/ui.js';
import {
  formatBytes,
  minutesOf,
  parseQuota,
  pricesFromCsv,
  pricesToCsv,
  quotaText,
  useAdminUserMutations,
  useAdminUsers,
  useAiPrices,
  useInstanceSettings,
  useInviteMutations,
  useInvites,
  useSaveAiPrices,
  useSystemStatus,
  useUpdateInstanceSettings,
} from '../lib/admin.js';
import { useSession } from '../lib/session.js';

/** Reads a trimmed text field of a submitted form. */
function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** A secret shown once, with a button to copy it. */
function OneTimeSecret({ label, value, note }: { label: string; value: string; note: string }) {
  const { t } = useTranslation();
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1 rounded-md bg-slate-50 p-3">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          data-testid="one-time-secret"
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs"
        />
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? t('share.links.copied') : t('share.links.copy')}
        </Button>
      </div>
      <p className="text-xs text-slate-600">{note}</p>
    </div>
  );
}

// --- Users ------------------------------------------------------------------------------

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { create } = useAdminUserMutations();
  const fieldError = useFieldError(create.error);
  const [password, setPassword] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPassword(null);
          create.reset();
        }
        onOpenChange(next);
      }}
      title={t('admin.users.createTitle')}
    >
      {password === null ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            create.mutate(
              {
                email: field(form, 'email'),
                username: field(form, 'username'),
                displayName: field(form, 'displayName'),
                isAdmin: form.get('isAdmin') === 'on',
              },
              {
                onSuccess: (created) => {
                  setPassword(created.temporaryPassword);
                },
              },
            );
          }}
        >
          <TextField
            label={t('auth.fields.displayName')}
            name="displayName"
            required
            error={fieldError('displayName')}
          />
          <TextField
            label={t('auth.fields.username')}
            name="username"
            required
            error={fieldError('username')}
          />
          <TextField
            label={t('auth.fields.email')}
            name="email"
            type="email"
            required
            error={fieldError('email')}
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isAdmin" />
            {t('admin.users.makeAdmin')}
          </label>
          {!fieldError('email') && !fieldError('username') && <ErrorAlert error={create.error} />}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={create.isPending}>
              {t('admin.users.create')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <OneTimeSecret
            label={t('admin.users.temporaryPassword')}
            value={password}
            note={t('admin.users.temporaryPasswordNote')}
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                setPassword(null);
              }}
            >
              {t('common.close')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** A person's details, rights and quotas, as the administrator changes them. */
function UserDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const { t } = useTranslation();
  const { update, resetPassword } = useAdminUserMutations();
  const [password, setPassword] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={user.displayName}
      description={`${user.username} · ${user.email}`}
      wide
    >
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={update.isPending}
          onClick={() => {
            update.mutate({ id: user.id, disabled: !user.disabled }, { onSuccess: onClose });
          }}
        >
          {user.disabled ? t('admin.users.enable') : t('admin.users.disable')}
        </Button>
        <Button
          disabled={update.isPending}
          onClick={() => {
            update.mutate({ id: user.id, isAdmin: !user.isAdmin }, { onSuccess: onClose });
          }}
        >
          {user.isAdmin ? t('admin.users.revokeAdmin') : t('admin.users.grantAdmin')}
        </Button>
        <Button
          disabled={resetPassword.isPending}
          onClick={() => {
            resetPassword.mutate(user.id, {
              onSuccess: (reset) => {
                setPassword(reset.temporaryPassword);
              },
            });
          }}
        >
          {user.hasPassword ? t('admin.users.resetPassword') : t('admin.users.givePassword')}
        </Button>
      </div>
      {password !== null && (
        <OneTimeSecret
          label={t('admin.users.temporaryPassword')}
          value={password}
          note={t('admin.users.resetNote')}
        />
      )}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const storageMb = parseQuota(field(form, 'storageMb'), true);
          const compileMinutes = parseQuota(field(form, 'compileMinutes'), true);
          setInvalid(storageMb === undefined || compileMinutes === undefined);
          if (storageMb === undefined || compileMinutes === undefined) return;
          update.mutate(
            { id: user.id, quotas: { storageMb, compileMinutes } },
            { onSuccess: onClose },
          );
        }}
      >
        <h3 className="text-sm font-semibold">{t('admin.users.quotas')}</h3>
        <p className="text-xs text-slate-600">{t('admin.users.quotasHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t('admin.quotas.storageMb')}
            name="storageMb"
            inputMode="numeric"
            defaultValue={quotaText(user.quotas.storageMb)}
          />
          <TextField
            label={t('admin.quotas.compileMinutes')}
            name="compileMinutes"
            inputMode="numeric"
            defaultValue={quotaText(user.quotas.compileMinutes)}
          />
        </div>
        {invalid && (
          <p role="alert" className="text-sm text-red-700">
            {t('admin.quotas.invalid')}
          </p>
        )}
        <ErrorAlert error={update.error ?? resetPassword.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.close')}</Button>
          <Button type="submit" variant="primary" disabled={update.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function UsersTab() {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const users = useAdminUsers(query, offset);
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' });
  const list = users.data?.users ?? [];
  const total = users.data?.total ?? 0;
  const current = list.find((user) => user.id === selected);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <TextField
            label={t('admin.users.search')}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setOffset(0);
            }}
          />
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setCreating(true);
          }}
        >
          {t('admin.users.create')}
        </Button>
      </div>
      <ErrorAlert error={users.error} />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-600">
            <tr>
              <th className="py-2 pr-3 font-medium">{t('admin.users.person')}</th>
              <th className="py-2 pr-3 font-medium">{t('admin.users.storage')}</th>
              <th className="py-2 pr-3 font-medium">{t('admin.users.compile')}</th>
              <th className="py-2 pr-3 font-medium">{t('admin.users.lastSeen')}</th>
              <th className="py-2 font-medium">
                <span className="sr-only">{t('admin.users.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.map((user) => (
              <tr key={user.id} data-testid="admin-user-row">
                <td className="py-2 pr-3">
                  <span className="font-medium">{user.displayName}</span>{' '}
                  <span className="text-slate-600">
                    {user.username} · {user.email}
                  </span>
                  <span className="ml-1 space-x-1 text-xs">
                    {user.isAdmin && (
                      <span className="rounded bg-accent/10 px-1 text-accent">
                        {t('admin.users.admin')}
                      </span>
                    )}
                    {user.disabled && (
                      <span className="rounded bg-red-50 px-1 text-red-800">
                        {t('admin.users.disabled')}
                      </span>
                    )}
                    {user.oidc && (
                      <span className="rounded bg-slate-100 px-1">{t('admin.users.sso')}</span>
                    )}
                  </span>
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {formatBytes(user.storageBytes, i18n.language)}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {t('admin.users.minutes', { count: minutesOf(user.compileSecondsThisMonth) })}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {user.lastSeenAt === null
                    ? t('admin.users.never')
                    : date.format(new Date(user.lastSeenAt))}
                </td>
                <td className="py-2 text-right">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSelected(user.id);
                    }}
                  >
                    {t('admin.users.manage')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-sm text-slate-600">
        <span className="mr-auto">{t('admin.users.total', { count: total })}</span>
        <Button
          variant="ghost"
          disabled={offset === 0}
          onClick={() => {
            setOffset(Math.max(0, offset - ADMIN_USERS_PAGE));
          }}
        >
          {t('admin.users.previous')}
        </Button>
        <Button
          variant="ghost"
          disabled={offset + ADMIN_USERS_PAGE >= total}
          onClick={() => {
            setOffset(offset + ADMIN_USERS_PAGE);
          }}
        >
          {t('admin.users.next')}
        </Button>
      </div>
      <CreateUserDialog open={creating} onOpenChange={setCreating} />
      {current && (
        <UserDialog
          user={current}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

// --- Invitations --------------------------------------------------------------------

function InvitesTab() {
  const { t, i18n } = useTranslation();
  const invites = useInvites();
  const { create, remove } = useInviteMutations();
  const [link, setLink] = useState<string | null>(null);
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' });
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">{t('admin.invites.intro')}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const days = Number(new FormData(event.currentTarget).get('days'));
          create.mutate(days, {
            onSuccess: ({ token }) => {
              setLink(`${window.location.origin}/register?invite=${token}`);
            },
          });
        }}
      >
        <label className="space-y-1 text-sm">
          <span className="block font-medium">{t('admin.invites.validity')}</span>
          <select
            name="days"
            defaultValue="7"
            className="rounded-md border border-slate-300 px-2 py-2 text-sm"
          >
            {[1, 7, 30, 90].map((days) => (
              <option key={days} value={days}>
                {t('share.links.days', { count: days })}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {t('admin.invites.create')}
        </Button>
      </form>
      {link !== null && (
        <OneTimeSecret
          label={t('admin.invites.link')}
          value={link}
          note={t('admin.invites.once')}
        />
      )}
      <ErrorAlert error={invites.error ?? create.error ?? remove.error} />
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
        {(invites.data ?? []).map((invite) => (
          <li key={invite.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="mr-auto">
              {invite.usedAt === null
                ? t('admin.invites.pending', {
                    created: date.format(new Date(invite.createdAt)),
                    expires: date.format(new Date(invite.expiresAt)),
                  })
                : t('admin.invites.used', { date: date.format(new Date(invite.usedAt)) })}
            </span>
            {invite.usedAt === null && (
              <Button
                variant="ghost"
                onClick={() => {
                  remove.mutate(invite.id);
                }}
              >
                {t('share.links.revoke')}
              </Button>
            )}
          </li>
        ))}
        {invites.data?.length === 0 && (
          <li className="px-3 py-2 text-slate-600">{t('admin.invites.none')}</li>
        )}
      </ul>
    </div>
  );
}

// --- Instance -----------------------------------------------------------------------

function Overridden({ keys, name }: { keys: readonly string[]; name: string }) {
  const { t } = useTranslation();
  return (
    <p className="text-xs text-slate-600">
      {keys.includes(name) ? t('admin.instance.fromConsole') : t('admin.instance.fromEnv')}
    </p>
  );
}

function InstanceTab() {
  const { t } = useTranslation();
  const settings = useInstanceSettings();
  const save = useUpdateInstanceSettings();
  const [invalid, setInvalid] = useState(false);
  if (!settings.data) return <ErrorAlert error={settings.error} />;
  const data = settings.data;
  return (
    <div className="max-w-2xl space-y-6">
      <section className="space-y-2" aria-labelledby="registration-title">
        <h2 id="registration-title" className="text-base font-semibold">
          {t('admin.instance.registration')}
        </h2>
        <Overridden keys={data.overridden} name="registrationMode" />
        <select
          aria-labelledby="registration-title"
          value={data.registrationMode}
          disabled={save.isPending}
          onChange={(event) => {
            const mode: RegistrationMode = registrationMode.parse(event.currentTarget.value);
            save.mutate({ registrationMode: mode });
          }}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        >
          {registrationMode.options.map((mode) => (
            <option key={mode} value={mode}>
              {t(`admin.instance.modes.${mode}`)}
            </option>
          ))}
        </select>
      </section>
      <section className="space-y-2" aria-labelledby="quotas-title">
        <h2 id="quotas-title" className="text-base font-semibold">
          {t('admin.quotas.title')}
        </h2>
        <Overridden keys={data.overridden} name="quotas" />
        <p className="text-sm text-slate-700">{t('admin.quotas.intro')}</p>
        <form
          key={`${quotaText(data.quotas.storageMb)}/${quotaText(data.quotas.compileMinutes)}`}
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const storageMb = parseQuota(field(form, 'storageMb'));
            const compileMinutes = parseQuota(field(form, 'compileMinutes'));
            setInvalid(storageMb === undefined || compileMinutes === undefined);
            if (storageMb === undefined || compileMinutes === undefined) return;
            save.mutate({ quotas: { storageMb, compileMinutes } });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label={t('admin.quotas.storageMb')}
              name="storageMb"
              inputMode="numeric"
              defaultValue={quotaText(data.quotas.storageMb)}
              hint={t('admin.quotas.emptyUnlimited')}
            />
            <TextField
              label={t('admin.quotas.compileMinutes')}
              name="compileMinutes"
              inputMode="numeric"
              defaultValue={quotaText(data.quotas.compileMinutes)}
              hint={t('admin.quotas.emptyUnlimited')}
            />
          </div>
          {invalid && (
            <p role="alert" className="text-sm text-red-700">
              {t('admin.quotas.invalid')}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {t('common.save')}
          </Button>
        </form>
      </section>
      <ErrorAlert error={save.error} />
    </div>
  );
}

// --- Assistant ----------------------------------------------------------------------

function AiTab() {
  const { t } = useTranslation();
  const settings = useInstanceSettings();
  const save = useUpdateInstanceSettings();
  const fieldError = useFieldError(save.error);
  const prices = useAiPrices();
  const savePrices = useSaveAiPrices();
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [badLine, setBadLine] = useState<number | null>(null);
  if (!settings.data) return <ErrorAlert error={settings.error} />;
  const { aiEnabled, aiDefault, overridden } = settings.data;
  const chosen = provider ?? aiDefault?.provider ?? 'anthropic';
  return (
    <div className="max-w-2xl space-y-6">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={aiEnabled}
          disabled={save.isPending}
          onChange={(event) => {
            save.mutate({ aiEnabled: event.currentTarget.checked });
          }}
        />
        {t('admin.ai.enabled')}
      </label>
      <section className="space-y-3" aria-labelledby="ai-default-title">
        <h2 id="ai-default-title" className="text-base font-semibold">
          {t('admin.ai.default')}
        </h2>
        <Overridden keys={overridden} name="aiDefault" />
        <p className="text-sm text-slate-700">{t('admin.ai.defaultIntro')}</p>
        <form
          key={`${aiDefault?.provider ?? ''}/${aiDefault?.model ?? ''}/${aiDefault?.keyHint ?? ''}`}
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const apiKey = field(form, 'apiKey');
            const baseUrl = field(form, 'baseUrl');
            const contextTokens = field(form, 'contextTokens');
            const vision = field(form, 'vision');
            save.mutate(
              {
                aiDefault: {
                  provider: chosen,
                  model: field(form, 'model'),
                  baseUrl: baseUrl === '' ? null : baseUrl,
                  ...(apiKey === '' ? {} : { apiKey }),
                  vision: vision === '' ? null : vision === 'true',
                  contextTokens: contextTokens === '' ? null : Number(contextTokens),
                },
              },
              {
                onSuccess: () => {
                  setProvider(null);
                },
              },
            );
          }}
        >
          <label className="block space-y-1 text-sm">
            <span className="block font-medium">{t('account.ai.provider')}</span>
            <select
              value={chosen}
              onChange={(event) => {
                setProvider(aiProvider.parse(event.currentTarget.value));
              }}
              className="rounded-md border border-slate-300 px-2 py-1.5"
            >
              {aiProviders.map((value) => (
                <option key={value} value={value}>
                  {t(`account.ai.providers.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label={t('account.ai.model')}
            name="model"
            required
            defaultValue={aiDefault?.model ?? ''}
            autoComplete="off"
            spellCheck={false}
            error={fieldError('aiDefault.model')}
          />
          <TextField
            label={t('account.ai.baseUrl')}
            name="baseUrl"
            type="url"
            defaultValue={aiDefault?.baseUrl ?? ''}
            hint={t('admin.ai.baseUrlHint')}
            autoComplete="off"
            error={fieldError('aiDefault.baseUrl')}
          />
          <TextField
            label={t('account.ai.key')}
            name="apiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            hint={
              aiDefault?.keyHint && chosen === aiDefault.provider
                ? `${t('account.ai.keyStored', { hint: aiDefault.keyHint })} ${t('account.ai.keyHint')}`
                : t('account.ai.noKey')
            }
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-sm">
              <span className="block font-medium">{t('admin.ai.vision')}</span>
              <select
                name="vision"
                defaultValue={
                  aiDefault?.vision === null || !aiDefault ? '' : String(aiDefault.vision)
                }
                className="rounded-md border border-slate-300 px-2 py-1.5"
              >
                <option value="">{t('admin.ai.auto')}</option>
                <option value="true">{t('admin.ai.yes')}</option>
                <option value="false">{t('admin.ai.no')}</option>
              </select>
            </label>
            <TextField
              label={t('admin.ai.contextTokens')}
              name="contextTokens"
              inputMode="numeric"
              defaultValue={
                aiDefault?.contextTokens === null ? '' : String(aiDefault?.contextTokens ?? '')
              }
              hint={t('admin.ai.autoHint')}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {t('common.save')}
            </Button>
            {overridden.includes('aiDefault') && (
              <Button
                variant="ghost"
                disabled={save.isPending}
                onClick={() => {
                  save.mutate({ aiDefault: null });
                }}
              >
                {t('admin.ai.backToEnv')}
              </Button>
            )}
          </div>
          <ErrorAlert error={save.error} />
        </form>
      </section>
      <section className="space-y-2" aria-labelledby="prices-title">
        <h2 id="prices-title" className="text-base font-semibold">
          {t('admin.ai.prices')}
        </h2>
        <p className="text-sm text-slate-700">{t('admin.ai.pricesIntro')}</p>
        {prices.data && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = pricesFromCsv(field(new FormData(event.currentTarget), 'prices'));
              if ('line' in parsed) {
                setBadLine(parsed.line);
                return;
              }
              setBadLine(null);
              savePrices.mutate(parsed.prices);
            }}
          >
            <textarea
              name="prices"
              aria-labelledby="prices-title"
              rows={8}
              spellCheck={false}
              defaultValue={pricesToCsv(prices.data)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
            />
            {badLine !== null && (
              <p role="alert" className="text-sm text-red-700">
                {t('admin.ai.badLine', { line: badLine })}
              </p>
            )}
            <Button type="submit" disabled={savePrices.isPending}>
              {t('admin.ai.savePrices')}
            </Button>
            {savePrices.isSuccess && (
              <p className="text-sm text-slate-600">{t('admin.ai.pricesSaved')}</p>
            )}
          </form>
        )}
        <ErrorAlert error={prices.error ?? savePrices.error} />
      </section>
    </div>
  );
}

// --- Services -----------------------------------------------------------------------

function ServicesTab() {
  const { t, i18n } = useTranslation();
  const status = useSystemStatus();
  if (!status.data) return <ErrorAlert error={status.error} />;
  const data = status.data;
  const rows: [string, string][] = [
    [t('admin.services.version'), data.version],
    [t('admin.services.texlive'), data.texliveVersion ?? t('admin.services.unknown')],
    [
      t('admin.services.queue'),
      t('admin.services.queueDetail', {
        waiting: data.compileQueue.waiting,
        active: data.compileQueue.active,
        failed: data.compileQueue.failed,
      }),
    ],
    [
      t('admin.services.lastDay'),
      Object.entries(data.compilesLastDay)
        .map(
          ([status, count]) => `${t(`admin.services.outcomes.${status}`, status)} ${String(count)}`,
        )
        .join(' · ') || '0',
    ],
    [
      t('admin.services.users'),
      t('admin.services.usersDetail', {
        total: data.users.total,
        active: data.users.active30Days,
      }),
    ],
    [t('admin.services.projects'), String(data.projects)],
    [t('admin.services.storage'), formatBytes(data.storageBytes, i18n.language)],
    [t('admin.services.sso'), data.oidc?.issuer ?? t('admin.services.ssoOff')],
  ];
  return (
    <div className="space-y-3">
      <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-medium">{label}</dt>
            <dd className="break-all text-slate-700">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm">
        <a href="/status" className="underline">
          {t('admin.services.health')}
        </a>
      </p>
    </div>
  );
}

const TABS = ['users', 'invites', 'instance', 'ai', 'services'] as const;

/** Administration console (SPEC §3.9), for instance administrators only. */
export function AdminPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  if (user && !user.isAdmin) {
    return <p className="text-sm">{t('admin.forbidden')}</p>;
  }
  const panels = {
    users: <UsersTab />,
    invites: <InvitesTab />,
    instance: <InstanceTab />,
    ai: <AiTab />,
    services: <ServicesTab />,
  };
  return (
    <div className="space-y-4">
      <h1 className="font-serif text-2xl font-semibold">{t('admin.title')}</h1>
      <Tabs.Root defaultValue="users" className="space-y-4">
        <Tabs.List
          aria-label={t('admin.title')}
          className="flex flex-wrap gap-1 border-b border-slate-200"
        >
          {TABS.map((tab) => (
            <Tabs.Trigger
              key={tab}
              value={tab}
              className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm data-[state=active]:border-accent data-[state=active]:font-medium"
            >
              {t(`admin.tabs.${tab}`)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {TABS.map((tab) => (
          <Tabs.Content key={tab} value={tab}>
            {panels[tab]}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </div>
  );
}
