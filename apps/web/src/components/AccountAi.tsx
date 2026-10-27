import { type AiProvider, aiProvider, aiProviders } from '@galley/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCost, useAiProvider, useAiProviderMutations, useAiUsage } from '../lib/ai.js';
import { Button, ErrorAlert, TextField, useFieldError } from './ui.js';

function UsageSummary() {
  const { t, i18n } = useTranslation();
  const usage = useAiUsage();
  if (!usage.data) return <ErrorAlert error={usage.error} />;
  const data = usage.data;
  return (
    <div className="space-y-1 text-sm" data-testid="ai-usage-summary">
      <h3 className="font-medium">{t('account.ai.usage.title')}</h3>
      {data.requests === 0 ? (
        <p className="text-slate-600">{t('account.ai.usage.none')}</p>
      ) : (
        <>
          <p>
            {t('account.ai.usage.requests', { count: data.requests })} ·{' '}
            {t('account.ai.usage.tokens', { input: data.inputTokens, output: data.outputTokens })}
          </p>
          {data.costs.length > 0 && (
            <p>
              {t('account.ai.usage.cost', {
                cost: data.costs
                  .map((cost) => formatCost(cost.micros, cost.currency, i18n.language))
                  .join(' + '),
              })}
            </p>
          )}
          <ul className="text-xs text-slate-600">
            {data.byModel.map((row) => (
              <li key={`${row.provider}/${row.model}/${row.currency ?? ''}`}>
                {row.provider} / {row.model} :{' '}
                {t('account.ai.usage.requests', { count: row.requests })}
              </li>
            ))}
          </ul>
          {data.unpricedRequests > 0 && (
            <p className="text-xs text-slate-600">
              {t('account.ai.usage.unpriced', { count: data.unpricedRequests })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The user's own model for the assistant: provider, model, address and key.
 * The key is sent once and only its last characters come back.
 */
export function AiSection() {
  const { t } = useTranslation();
  const settings = useAiProvider();
  const { save, remove } = useAiProviderMutations();
  const fieldError = useFieldError(save.error);
  const config = settings.data?.config ?? null;
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const chosen = provider ?? config?.provider ?? 'anthropic';
  if (!settings.data) return <ErrorAlert error={settings.error} />;
  const { instance, allowUserEndpoints, enabled } = settings.data;
  // The address is needed for a compatible server, optional elsewhere, and only if allowed.
  const showBaseUrl = allowUserEndpoints || chosen === 'openai-compatible';

  return (
    <section aria-labelledby="ai-title" className="max-w-2xl space-y-3">
      <h2 id="ai-title" className="text-lg font-semibold">
        {t('account.ai.title')}
      </h2>
      {!enabled ? (
        <p className="text-sm text-slate-700">{t('account.ai.disabled')}</p>
      ) : (
        <>
          <p className="text-sm text-slate-700">{t('account.ai.intro')}</p>
          <p className="text-sm text-slate-700">
            {instance === null
              ? t('account.ai.noDefault')
              : t('account.ai.instanceDefault', instance)}
          </p>
          <form
            // A new configuration from the server resets the form's fields.
            key={`${config?.provider ?? ''}/${config?.model ?? ''}/${config?.keyHint ?? ''}`}
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const read = (name: string) => {
                const value = form.get(name);
                return typeof value === 'string' ? value.trim() : '';
              };
              const apiKey = read('apiKey');
              const baseUrl = read('baseUrl');
              save.mutate(
                {
                  provider: chosen,
                  model: read('model'),
                  ...(showBaseUrl ? { baseUrl: baseUrl === '' ? null : baseUrl } : {}),
                  ...(apiKey === '' ? {} : { apiKey }),
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
                name="provider"
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
              defaultValue={config?.model ?? ''}
              placeholder={t('account.ai.modelPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              error={fieldError('model')}
            />
            {showBaseUrl && (
              <TextField
                label={t('account.ai.baseUrl')}
                name="baseUrl"
                type="url"
                defaultValue={config?.baseUrl ?? ''}
                hint={t(
                  allowUserEndpoints ? 'account.ai.baseUrlHint' : 'account.ai.baseUrlForbidden',
                )}
                autoComplete="off"
                error={fieldError('baseUrl')}
              />
            )}
            <TextField
              label={t('account.ai.key')}
              name="apiKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              hint={
                config?.keyHint && chosen === config.provider
                  ? `${t('account.ai.keyStored', { hint: config.keyHint })} ${t('account.ai.keyHint')}`
                  : t('account.ai.noKey')
              }
              error={fieldError('apiKey')}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={save.isPending}>
                {t('account.ai.save')}
              </Button>
              {config !== null && (
                <Button
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => {
                    remove.mutate();
                  }}
                >
                  {t('account.ai.remove')}
                </Button>
              )}
            </div>
            <ErrorAlert
              error={
                (fieldError('model') ?? fieldError('baseUrl') ?? fieldError('apiKey'))
                  ? remove.error
                  : (save.error ?? remove.error)
              }
            />
          </form>
          <UsageSummary />
        </>
      )}
    </section>
  );
}
