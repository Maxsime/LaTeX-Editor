import {
  citeKeyPattern,
  DEFAULT_CHKTEX_DISABLED,
  DEFAULT_CITE_KEY_PATTERN,
  type ProjectDetails,
  spellLanguage,
  spellLanguages,
} from '@galley/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAiStatus } from '../lib/ai.js';
import { useUpdateProject } from '../lib/projects.js';
import { parseRules } from '../lib/writing.js';
import { ErrorAlert } from './ui.js';

/** Project settings of the writing tools: checking language, citation keys, chktex rules. */
export function WritingOptions({
  project,
  canEdit,
}: {
  project: ProjectDetails;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const update = useUpdateProject(project.id);
  const [pattern, setPattern] = useState(project.citeKeyPattern);
  const [rules, setRules] = useState(project.chktexDisabled.join(', '));
  const parsedRules = parseRules(rules);
  const validPattern = citeKeyPattern.safeParse(pattern).success;
  const select = 'rounded border border-slate-300 px-1 py-0.5 disabled:bg-slate-100';
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-xs font-semibold text-slate-600 uppercase">
        {t('writing.options.title')}
      </legend>
      <label className="flex items-center justify-between gap-2">
        {t('writing.options.language')}
        <select
          className={select}
          disabled={!canEdit}
          value={project.spellLanguage}
          onChange={(event) => {
            update.mutate({ spellLanguage: spellLanguage.parse(event.currentTarget.value) });
          }}
        >
          {spellLanguages.map((value) => (
            <option key={value} value={value}>
              {t(`writing.languages.${value}`)}
            </option>
          ))}
        </select>
      </label>
      <form
        className="space-y-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (validPattern) update.mutate({ citeKeyPattern: pattern });
        }}
      >
        <label className="block space-y-1">
          <span className="block">{t('writing.options.keyPattern')}</span>
          <span className="flex gap-1">
            <input
              value={pattern}
              disabled={!canEdit}
              aria-invalid={!validPattern}
              onChange={(event) => {
                setPattern(event.currentTarget.value);
              }}
              onBlur={() => {
                if (validPattern && pattern !== project.citeKeyPattern) {
                  update.mutate({ citeKeyPattern: pattern });
                }
              }}
              className={`${select} min-w-0 flex-1 font-mono text-xs aria-[invalid=true]:border-red-600`}
            />
          </span>
        </label>
        <p className="text-xs text-slate-600">
          {t('writing.options.keyPatternHint', { example: DEFAULT_CITE_KEY_PATTERN })}
        </p>
      </form>
      <label className="block space-y-1">
        <span className="block">{t('writing.options.chktex')}</span>
        <input
          value={rules}
          disabled={!canEdit}
          aria-invalid={parsedRules === null}
          onChange={(event) => {
            setRules(event.currentTarget.value);
          }}
          onBlur={() => {
            if (parsedRules !== null && parsedRules.join() !== project.chktexDisabled.join()) {
              update.mutate({ chktexDisabled: parsedRules });
            }
          }}
          className={`${select} w-full font-mono text-xs aria-[invalid=true]:border-red-600`}
        />
      </label>
      <p className="text-xs text-slate-600">
        {t('writing.options.chktexHint', { defaults: DEFAULT_CHKTEX_DISABLED.join(', ') })}
      </p>
      <ErrorAlert error={update.error} />
    </fieldset>
  );
}

/**
 * The owner's switch for the assistant in the project. Hidden when the
 * instance has turned the assistant off: there is nothing to switch.
 */
export function AiOption({ project }: { project: ProjectDetails }) {
  const { t } = useTranslation();
  const update = useUpdateProject(project.id);
  const status = useAiStatus(project.id);
  if (project.role !== 'owner' || status.data?.reason === 'instance-disabled') return null;
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2" title={t('ai.options.enabledHint')}>
        <input
          type="checkbox"
          checked={project.aiEnabled}
          disabled={update.isPending}
          onChange={(event) => {
            update.mutate({ aiEnabled: event.currentTarget.checked });
          }}
        />
        {t('ai.options.enabled')}
      </label>
      <ErrorAlert error={update.error} />
    </div>
  );
}
