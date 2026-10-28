import type { TemplateSummary } from '@galley/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOpenTexmf, useTemplateMutations, useTemplates } from '../lib/library.js';
import { useSession } from '../lib/session.js';
import { Button, ConfirmDialog, ErrorAlert } from './ui.js';

/** Entry point to the personal texmf tree (SPEC §6.1). */
export function TexmfSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const texmf = useOpenTexmf();
  return (
    <section aria-labelledby="texmf-title" className="max-w-2xl space-y-3">
      <h2 id="texmf-title" className="text-lg font-semibold">
        {t('library.texmf.title')}
      </h2>
      <p className="text-sm text-slate-700">{t('library.texmf.help')}</p>
      <ErrorAlert error={texmf.error} />
      <Button
        disabled={texmf.isPending}
        onClick={() => {
          texmf.mutate(undefined, {
            onSuccess: ({ projectId }) => {
              void navigate({ to: '/projects/$projectId', params: { projectId } });
            },
          });
        }}
      >
        {t('library.texmf.open')}
      </Button>
    </section>
  );
}

/** The person's saved templates, and for administrators those of the instance. */
export function TemplatesSection() {
  const { t } = useTranslation();
  const { user } = useSession();
  const templates = useTemplates();
  const mutations = useTemplateMutations();
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
  const isAdmin = user?.isAdmin === true;
  const editable = (templates.data ?? []).filter((template) => template.mine || isAdmin);
  return (
    <section aria-labelledby="templates-title" className="max-w-2xl space-y-3">
      <h2 id="templates-title" className="text-lg font-semibold">
        {t('library.templates.title')}
      </h2>
      <p className="text-sm text-slate-700">{t('library.templates.help')}</p>
      <ErrorAlert error={templates.error ?? mutations.update.error ?? mutations.remove.error} />
      {editable.length === 0 ? (
        <p className="text-sm text-slate-600">{t('library.templates.empty')}</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
          {editable.map((template) => (
            <li key={template.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <div className="mr-auto">
                <p className="font-medium">{template.name}</p>
                <p className="text-xs text-slate-600">
                  {t('library.templates.details', {
                    count: template.files,
                    owner: template.ownerName,
                  })}
                  {template.visibility === 'instance' && ` · ${t('library.templates.instance')}`}
                </p>
              </div>
              {isAdmin && (
                <Button
                  variant="ghost"
                  disabled={mutations.update.isPending}
                  onClick={() => {
                    mutations.update.mutate({
                      id: template.id,
                      visibility: template.visibility === 'instance' ? 'private' : 'instance',
                    });
                  }}
                >
                  {template.visibility === 'instance'
                    ? t('library.templates.unpublish')
                    : t('library.templates.publish')}
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  setDeleting(template);
                }}
              >
                {t('library.templates.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('library.templates.delete')}
        description={t('library.templates.confirmDelete', { name: deleting?.name ?? '' })}
        confirmLabel={t('library.templates.delete')}
        pending={mutations.remove.isPending}
        onConfirm={() => {
          if (deleting === null) return;
          mutations.remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null);
            },
          });
        }}
      />
    </section>
  );
}
