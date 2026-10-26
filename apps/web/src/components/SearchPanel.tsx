import { type SyntheticEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type SearchInput, useProjectReplace, useProjectSearch } from '../lib/editor.js';
import { useEditor } from '../stores/editor.js';
import { Button, ConfirmDialog, ErrorAlert } from './ui.js';

const OPTIONS = ['caseSensitive', 'wholeWord', 'regex'] as const;

/** Project-wide search and replace; results open the file at the match. */
export function SearchPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SearchInput>({
    q: '',
    regex: false,
    caseSensitive: false,
    wholeWord: false,
  });
  const [submitted, setSubmitted] = useState<SearchInput | null>(null);
  const [replacement, setReplacement] = useState('');
  const [confirming, setConfirming] = useState(false);
  const search = useProjectSearch(projectId, submitted);
  const replace = useProjectReplace(projectId);
  const revealAt = useEditor((state) => state.revealAt);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setSubmitted({ ...draft });
    replace.reset();
  };

  const matches = search.data?.matches ?? [];
  const files = new Set(matches.map((match) => match.fileId)).size;

  return (
    <div className="space-y-3 text-sm" data-testid="search-panel">
      <form onSubmit={submit} className="space-y-2" role="search">
        <input
          type="search"
          aria-label={t('editor.search.query')}
          placeholder={t('editor.search.query')}
          value={draft.q}
          onChange={(event) => {
            setDraft({ ...draft, q: event.currentTarget.value });
          }}
          className="w-full rounded-md border border-slate-300 px-2 py-1"
        />
        <div className="flex flex-wrap gap-3 text-xs">
          {OPTIONS.map((option) => (
            <label key={option} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={draft[option]}
                onChange={(event) => {
                  setDraft({ ...draft, [option]: event.currentTarget.checked });
                }}
              />
              {t(`editor.search.${option}`)}
            </label>
          ))}
        </div>
        <Button type="submit" variant="primary" disabled={draft.q === ''}>
          {t('editor.search.submit')}
        </Button>
      </form>

      {canEdit && submitted !== null && matches.length > 0 && (
        <div className="space-y-2 border-t border-slate-200 pt-2">
          <input
            aria-label={t('editor.search.replacement')}
            placeholder={t('editor.search.replacement')}
            value={replacement}
            onChange={(event) => {
              setReplacement(event.currentTarget.value);
            }}
            className="w-full rounded-md border border-slate-300 px-2 py-1"
          />
          <Button
            disabled={replace.isPending}
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t('editor.search.replaceAll')}
          </Button>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t('editor.search.replaceAll')}
            description={t('editor.search.confirm', { count: matches.length, files })}
            confirmLabel={t('editor.search.replaceAll')}
            pending={replace.isPending}
            onConfirm={() => {
              replace.mutate(
                { ...submitted, replacement },
                {
                  onSettled: () => {
                    setConfirming(false);
                  },
                },
              );
            }}
          />
        </div>
      )}
      {/* Outside the block above, which disappears once every match is replaced. */}
      {replace.data && (
        <p role="status" className="text-xs text-slate-600">
          {t('editor.search.replaced', {
            count: replace.data.replacements,
            files: replace.data.files,
          })}
        </p>
      )}
      <ErrorAlert error={replace.error} />

      <ErrorAlert error={search.error} />
      {search.isFetching && <p className="text-slate-600">{t('common.loading')}</p>}
      {search.data && (
        <div className="space-y-1">
          <p role="status" className="text-xs text-slate-600">
            {search.data.truncated
              ? t('editor.search.truncated', { count: matches.length })
              : t('editor.search.count', { count: matches.length, files })}
          </p>
          <ul className="space-y-1" data-testid="search-results">
            {matches.map((match, index) => (
              <li
                key={`${match.fileId}:${String(match.line)}:${String(match.column)}:${String(index)}`}
              >
                <button
                  type="button"
                  onClick={() => {
                    revealAt({
                      fileId: match.fileId,
                      line: match.line,
                      column: match.column,
                      length: match.length,
                    });
                  }}
                  className="block w-full rounded px-1 py-0.5 text-left hover:bg-slate-100"
                >
                  <span className="block text-xs text-slate-500">
                    {match.path}:{match.line}
                  </span>
                  <span className="block truncate font-mono text-xs">
                    {match.preview.slice(0, match.previewOffset)}
                    <mark>
                      {match.preview.slice(match.previewOffset, match.previewOffset + match.length)}
                    </mark>
                    {match.preview.slice(match.previewOffset + match.length)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
