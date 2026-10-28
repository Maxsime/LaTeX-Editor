import type { ProjectSummary } from '@galley/shared';
import { useNavigate } from '@tanstack/react-router';
import { DropdownMenu } from 'radix-ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyName, useDuplicateProject, useSaveTemplate } from '../lib/library.js';
import { useSession } from '../lib/session.js';
import { Button, Dialog, ErrorAlert, NameDialog, TextField } from './ui.js';

const menuItem =
  'cursor-pointer rounded px-2 py-1 text-sm outline-none data-[highlighted]:bg-slate-100';

/** Saves a project as a template; administrators may publish it for everyone. */
export function SaveTemplateDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { user } = useSession();
  const save = useSaveTemplate(projectId);
  const [saved, setSaved] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSaved(false);
          save.reset();
        }
        onOpenChange(next);
      }}
      title={t('library.template.title')}
    >
      {saved ? (
        <div className="space-y-4">
          <p role="status">{t('library.template.saved')}</p>
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                setSaved(false);
              }}
            >
              {t('common.close')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const text = (name: string) => {
              const value = form.get(name);
              return typeof value === 'string' ? value.trim() : '';
            };
            save.mutate(
              {
                name: text('name'),
                description: text('description'),
                visibility: form.get('instance') === 'on' ? 'instance' : 'private',
              },
              {
                onSuccess: () => {
                  setSaved(true);
                },
              },
            );
          }}
        >
          <p className="text-sm text-slate-600">{t('library.template.help')}</p>
          <TextField
            label={t('library.template.name')}
            name="name"
            defaultValue={projectName}
            maxLength={150}
            autoFocus
            required
          />
          <TextField label={t('library.template.description')} name="description" maxLength={500} />
          {user?.isAdmin === true && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="instance" />
              {t('library.template.instance')}
            </label>
          )}
          <ErrorAlert error={save.error} />
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Per-project menu of the dashboard: duplicate, save as template. */
export function ProjectActionsMenu({ project }: { project: ProjectSummary }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const duplicate = useDuplicateProject();
  const [dialog, setDialog] = useState<'duplicate' | 'template' | null>(null);
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" aria-label={t('library.actions', { name: project.name })}>
            ⋯
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="min-w-48 rounded-md border border-slate-200 bg-white p-1 shadow-md">
            <DropdownMenu.Item
              className={menuItem}
              onSelect={() => {
                duplicate.reset();
                setDialog('duplicate');
              }}
            >
              {t('library.duplicate.action')}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={menuItem}
              onSelect={() => {
                setDialog('template');
              }}
            >
              {t('library.template.action')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <NameDialog
        open={dialog === 'duplicate'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={t('library.duplicate.title', { name: project.name })}
        label={t('library.duplicate.name')}
        initialValue={copyName(project.name, t('library.duplicate.suffix'))}
        submitLabel={t('library.duplicate.submit')}
        error={duplicate.error}
        pending={duplicate.isPending}
        onSubmit={(name) => {
          duplicate.mutate(
            { id: project.id, name },
            {
              onSuccess: ({ project: copy }) => {
                setDialog(null);
                void navigate({ to: '/projects/$projectId', params: { projectId: copy.id } });
              },
            },
          );
        }}
      />
      <SaveTemplateDialog
        projectId={project.id}
        projectName={project.name}
        open={dialog === 'template'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      />
    </>
  );
}
