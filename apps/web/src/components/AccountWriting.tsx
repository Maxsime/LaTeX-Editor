import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useDictionary,
  useDictionaryMutations,
  useWritingFeatures,
  useZoteroAccount,
  useZoteroMutations,
} from '../lib/writing.js';
import { Button, ErrorAlert, TextField, useFieldError } from './ui.js';

/** Link to a Zotero library through a personal API key, stored encrypted by the server. */
export function ZoteroSection() {
  const { t } = useTranslation();
  const features = useWritingFeatures();
  const available = features.data?.zotero === true;
  const account = useZoteroAccount(available);
  const { connect, disconnect } = useZoteroMutations();
  const fieldError = useFieldError(connect.error);
  if (!available) return null;
  return (
    <section aria-labelledby="zotero-title" className="max-w-2xl space-y-3">
      <h2 id="zotero-title" className="text-lg font-semibold">
        {t('account.zotero.title')}
      </h2>
      <p className="text-sm text-slate-700">{t('account.zotero.intro')}</p>
      <ErrorAlert error={account.error ?? disconnect.error} />
      {account.data?.connected === true ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span data-testid="zotero-account" className="mr-auto">
            {t('account.zotero.connected', {
              name: account.data.username ?? '',
              hint: account.data.keyHint ?? '',
            })}
          </span>
          <Button
            variant="ghost"
            disabled={disconnect.isPending}
            onClick={() => {
              disconnect.mutate();
            }}
          >
            {t('account.zotero.disconnect')}
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get('apiKey');
            const form = event.currentTarget;
            connect.mutate(typeof value === 'string' ? value.trim() : '', {
              onSuccess: () => {
                form.reset();
              },
            });
          }}
        >
          <div className="min-w-[16rem] flex-1">
            <TextField
              label={t('account.zotero.key')}
              name="apiKey"
              required
              autoComplete="off"
              spellCheck={false}
              hint={t('account.zotero.keyHint')}
              error={fieldError('apiKey')}
            />
          </div>
          <Button type="submit" variant="primary" disabled={connect.isPending}>
            {t('account.zotero.connect')}
          </Button>
          <div className="w-full">
            <ErrorAlert error={fieldError('apiKey') === undefined ? connect.error : null} />
          </div>
        </form>
      )}
    </section>
  );
}

/** The words the spell checker accepts for this user, in every project. */
export function DictionarySection() {
  const { t } = useTranslation();
  const features = useWritingFeatures();
  const available = features.data?.spelling === true;
  const dictionary = useDictionary(available);
  const { add, remove } = useDictionaryMutations();
  const [word, setWord] = useState('');
  if (!available) return null;
  const words = dictionary.data ?? [];
  return (
    <section aria-labelledby="dictionary-title" className="max-w-2xl space-y-3">
      <h2 id="dictionary-title" className="text-lg font-semibold">
        {t('account.dictionary.title')}
      </h2>
      <p className="text-sm text-slate-700">{t('account.dictionary.intro')}</p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = word.trim();
          if (value !== '') {
            add.mutate(value, {
              onSuccess: () => {
                setWord('');
              },
            });
          }
        }}
      >
        <input
          aria-label={t('account.dictionary.word')}
          value={word}
          maxLength={100}
          onChange={(event) => {
            setWord(event.currentTarget.value.replace(/\s/g, ''));
          }}
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={add.isPending}>
          {t('account.dictionary.add')}
        </Button>
      </form>
      <ErrorAlert error={dictionary.error ?? add.error ?? remove.error} />
      {words.length === 0 ? (
        <p className="text-sm text-slate-600">{t('account.dictionary.none')}</p>
      ) : (
        <ul className="flex flex-wrap gap-1" aria-label={t('account.dictionary.title')}>
          {words.map((entry) => (
            <li
              key={entry}
              className="flex items-center gap-1 rounded bg-slate-100 py-0.5 pr-1 pl-2 text-sm"
            >
              {entry}
              <button
                type="button"
                aria-label={t('account.dictionary.remove', { word: entry })}
                onClick={() => {
                  remove.mutate(entry);
                }}
                className="rounded px-1 text-slate-500 hover:bg-slate-200"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
