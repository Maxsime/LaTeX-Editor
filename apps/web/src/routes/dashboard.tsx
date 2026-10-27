import {
  type ProjectState,
  type ProjectSummary,
  type ProjectTemplate,
  type Tag,
  TRASH_RETENTION_DAYS,
} from '@galley/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { DropdownMenu, ToggleGroup } from 'radix-ui';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ConfirmDialog, Dialog, ErrorAlert, TextField } from '../components/ui.js';
import {
  actionsFor,
  type BulkAction,
  useBulkAction,
  useCreateProject,
  useImportProject,
  useProjects,
  useTagMutations,
  useTags,
} from '../lib/projects.js';
import { useAnswerInvite, useReceivedInvites } from '../lib/sharing.js';
import { useDashboard } from '../stores/dashboard.js';
import { useNotices } from '../stores/notices.js';

/** Text value of a form field; file fields read as empty. */
function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

const states: ProjectState[] = ['active', 'archived', 'trashed'];
const sorts = [
  'updatedAt:desc',
  'updatedAt:asc',
  'name:asc',
  'name:desc',
  'createdAt:desc',
  'createdAt:asc',
] as const;

function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateProject();
  const navigate = useNavigate();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('dashboard.create.title')}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          create.mutate(
            {
              name: formString(form, 'name').trim(),
              // The select only offers valid template names.
              template: formString(form, 'template') as ProjectTemplate,
            },
            {
              onSuccess: ({ project }) => {
                onOpenChange(false);
                void navigate({ to: '/projects/$projectId', params: { projectId: project.id } });
              },
            },
          );
        }}
      >
        <TextField
          label={t('dashboard.create.name')}
          name="name"
          maxLength={150}
          autoFocus
          required
        />
        <label className="block space-y-1 text-sm font-medium">
          <span>{t('dashboard.create.template')}</span>
          <select
            name="template"
            className="w-full rounded-md border border-slate-300 px-3 py-2 font-normal"
          >
            <option value="blank">{t('dashboard.create.templates.blank')}</option>
            <option value="article">{t('dashboard.create.templates.article')}</option>
          </select>
        </label>
        <ErrorAlert error={create.error} />
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ImportButton() {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const importProject = useImportProject();
  const setWarnings = useNotices((state) => state.setWarnings);
  const navigate = useNavigate();
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        data-testid="import-input"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!file) return;
          importProject.mutate(file, {
            onSuccess: ({ project, warnings }) => {
              setWarnings(project.id, warnings);
              void navigate({ to: '/projects/$projectId', params: { projectId: project.id } });
            },
          });
        }}
      />
      <Button disabled={importProject.isPending} onClick={() => input.current?.click()}>
        {importProject.isPending ? t('dashboard.importing') : t('dashboard.import')}
      </Button>
      {importProject.error !== null && (
        <div className="basis-full">
          <ErrorAlert error={importProject.error} />
        </div>
      )}
    </>
  );
}

/** Invitations to other people's projects, answered here since no e-mail is sent. */
function ReceivedInvites() {
  const { t } = useTranslation();
  const invites = useReceivedInvites();
  const answer = useAnswerInvite();
  const navigate = useNavigate();
  const list = invites.data ?? [];
  if (list.length === 0) return null;
  return (
    <section
      aria-labelledby="invites-title"
      className="space-y-2 rounded-md border border-accent/30 bg-sky-50 p-3"
    >
      <h2 id="invites-title" className="text-sm font-semibold">
        {t('dashboard.invites.title')}
      </h2>
      <ul className="space-y-1 text-sm">
        {list.map((invite) => (
          <li key={invite.id} className="flex flex-wrap items-center gap-2">
            <span className="mr-auto">
              {t(
                invite.invitedBy === null
                  ? 'dashboard.invites.anonymous'
                  : 'dashboard.invites.from',
                {
                  project: invite.project.name,
                  name: invite.invitedBy?.displayName ?? '',
                  role: t(`roles.${invite.role}`).toLocaleLowerCase(),
                },
              )}
            </span>
            <Button
              variant="primary"
              disabled={answer.isPending}
              onClick={() => {
                answer.mutate(
                  { id: invite.id, accept: true },
                  {
                    onSuccess: () =>
                      void navigate({
                        to: '/projects/$projectId',
                        params: { projectId: invite.project.id },
                      }),
                  },
                );
              }}
            >
              {t('dashboard.invites.accept')}
            </Button>
            <Button
              disabled={answer.isPending}
              onClick={() => {
                answer.mutate({ id: invite.id, accept: false });
              }}
            >
              {t('dashboard.invites.decline')}
            </Button>
          </li>
        ))}
      </ul>
      <ErrorAlert error={answer.error} />
    </section>
  );
}

/** Message left by the page that sent the user back to the dashboard. */
function Flash() {
  const { t } = useTranslation();
  const flash = useNotices((state) => state.flash);
  const setFlash = useNotices((state) => state.setFlash);
  if (flash === null) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-950"
    >
      <span className="mr-auto">{t(`dashboard.flash.${flash}`)}</span>
      <Button
        variant="ghost"
        onClick={() => {
          setFlash(null);
        }}
      >
        {t('common.close')}
      </Button>
    </div>
  );
}

function TagChip({ tag }: { tag: Tag }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-xs">
      <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
      {tag.name}
    </span>
  );
}

function TagMenu({ project, tags }: { project: ProjectSummary; tags: Tag[] }) {
  const { t } = useTranslation();
  const { apply } = useTagMutations();
  if (tags.length === 0) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" aria-label={`${t('dashboard.tags.apply')} : ${project.name}`}>
          #
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="min-w-40 rounded-md border border-slate-200 bg-white p-1 shadow-md">
          <DropdownMenu.Label className="px-2 py-1 text-xs text-slate-600">
            {t('dashboard.tags.apply')}
          </DropdownMenu.Label>
          {tags.map((tag) => (
            <DropdownMenu.CheckboxItem
              key={tag.id}
              checked={project.tagIds.includes(tag.id)}
              onCheckedChange={(on) => {
                apply.mutate({ projectId: project.id, tagId: tag.id, on });
              }}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm outline-none data-[highlighted]:bg-slate-100"
            >
              <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
              <TagChip tag={tag} />
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function TagManager({ tags }: { tags: Tag[] }) {
  const { t } = useTranslation();
  const { create, remove } = useTagMutations();
  return (
    <section aria-labelledby="tags-title" className="space-y-2">
      <h2 id="tags-title" className="text-sm font-semibold">
        {t('dashboard.tags.title')}
      </h2>
      <ul className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <li key={tag.id} className="flex items-center">
            <TagChip tag={tag} />
            <button
              type="button"
              className="ml-1 text-xs text-slate-500 hover:text-red-700"
              aria-label={t('dashboard.tags.delete', { name: tag.name })}
              onClick={() => {
                remove.mutate(tag.id);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          create.mutate(
            { name: formString(data, 'name').trim(), color: formString(data, 'color') },
            {
              onSuccess: () => {
                form.reset();
              },
            },
          );
        }}
      >
        <div className="flex-1">
          <TextField label={t('dashboard.tags.name')} name="name" maxLength={50} required />
        </div>
        <label className="text-sm">
          <span className="sr-only">{t('dashboard.tags.color')}</span>
          <input
            type="color"
            name="color"
            defaultValue="#1e3a5f"
            className="h-9 w-10 rounded border border-slate-300"
          />
        </label>
        <Button type="submit" disabled={create.isPending}>
          {t('dashboard.tags.new')}
        </Button>
      </form>
      <ErrorAlert error={create.error} />
    </section>
  );
}

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const dashboard = useDashboard();
  const projects = useProjects();
  const tags = useTags().data ?? [];
  const bulk = useBulkAction();
  const [creating, setCreating] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const list = projects.data ?? [];
  const selected = list.filter((project) => dashboard.selected.has(project.id));
  const dateFormat = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const tagById = new Map(tags.map((tag) => [tag.id, tag]));

  const run = (action: BulkAction): void => {
    bulk.mutate(
      { action, ids: selected.map((project) => project.id) },
      {
        onSettled: () => {
          dashboard.clearSelection();
          setConfirmPurge(false);
        },
      },
    );
  };

  return (
    <div className="grid gap-8 md:grid-cols-[1fr_16rem]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto font-serif text-3xl font-semibold">{t('dashboard.title')}</h1>
          <Button
            variant="primary"
            onClick={() => {
              setCreating(true);
            }}
          >
            {t('dashboard.newProject')}
          </Button>
          <ImportButton />
        </div>
        <NewProjectDialog open={creating} onOpenChange={setCreating} />
        <Flash />
        <ReceivedInvites />

        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup.Root
            type="single"
            value={dashboard.state}
            onValueChange={(value) => {
              // Radix sends '' when the active item is clicked again.
              // Items are built from `states`.
              if (value) dashboard.setState(value as ProjectState);
            }}
            className="inline-flex rounded-md border border-slate-300 p-0.5 text-sm"
          >
            {states.map((state) => (
              <ToggleGroup.Item
                key={state}
                value={state}
                className="rounded px-2 py-1 data-[state=on]:bg-accent data-[state=on]:text-white"
              >
                {t(`dashboard.states.${state}`)}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
          <input
            type="search"
            aria-label={t('dashboard.search')}
            placeholder={t('dashboard.search')}
            value={dashboard.search}
            onChange={(event) => {
              dashboard.setSearch(event.currentTarget.value);
            }}
            className="min-w-48 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
          <select
            aria-label={t('dashboard.sort.label')}
            value={`${dashboard.sort}:${dashboard.order}`}
            onChange={(event) => {
              // The options come from `sorts`, which only lists valid pairs.
              const [sort, order] = event.currentTarget.value.split(':') as [
                typeof dashboard.sort,
                'asc' | 'desc',
              ];
              dashboard.setSort(sort, order);
            }}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {sorts.map((value) => {
              // `sorts` only lists valid "sort:order" pairs.
              const [sort, order] = value.split(':') as [typeof dashboard.sort, 'asc' | 'desc'];
              return (
                <option key={value} value={value}>
                  {t(`dashboard.sort.${sort}`)} ({t(`dashboard.order.${order}`)})
                </option>
              );
            })}
          </select>
          {tags.length > 0 && (
            <select
              aria-label={t('dashboard.tags.title')}
              value={dashboard.tagId ?? ''}
              onChange={(event) => {
                dashboard.setTag(event.currentTarget.value || null);
              }}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">{t('dashboard.tags.all')}</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {dashboard.state === 'trashed' && (
          <p className="text-sm text-slate-600">
            {t('dashboard.trashNote', { days: TRASH_RETENTION_DAYS })}
          </p>
        )}

        {selected.length > 0 && (
          <div
            role="toolbar"
            aria-label={t('dashboard.selected', { count: selected.length })}
            className="flex flex-wrap items-center gap-2 rounded-md bg-slate-100 px-3 py-2 text-sm"
          >
            <span className="mr-auto">{t('dashboard.selected', { count: selected.length })}</span>
            {actionsFor(dashboard.state).map((action) => (
              <Button
                key={action}
                variant={action === 'purge' ? 'danger' : 'secondary'}
                disabled={bulk.isPending}
                onClick={() => {
                  if (action === 'purge') setConfirmPurge(true);
                  else run(action);
                }}
              >
                {t(`dashboard.actions.${action}`)}
              </Button>
            ))}
          </div>
        )}
        <ConfirmDialog
          open={confirmPurge}
          onOpenChange={setConfirmPurge}
          title={t('dashboard.actions.purge')}
          description={t('dashboard.confirmPurge', { count: selected.length })}
          confirmLabel={t('dashboard.actions.purge')}
          pending={bulk.isPending}
          onConfirm={() => {
            run('purge');
          }}
        />
        <ErrorAlert error={projects.error ?? bulk.error} />

        {list.length === 0 && !projects.isLoading ? (
          <p className="py-8 text-center text-slate-600">{t('dashboard.empty')}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-600">
              <tr>
                <th className="w-8 py-2">
                  <input
                    type="checkbox"
                    aria-label={t('dashboard.selectAll')}
                    checked={list.length > 0 && selected.length === list.length}
                    onChange={(event) => {
                      if (event.currentTarget.checked)
                        dashboard.selectAll(list.map((project) => project.id));
                      else dashboard.clearSelection();
                    }}
                  />
                </th>
                <th className="py-2">{t('dashboard.columns.name')}</th>
                <th className="hidden py-2 sm:table-cell">{t('dashboard.columns.owner')}</th>
                <th className="py-2">{t('dashboard.columns.updated')}</th>
                <th className="py-2">
                  <span className="sr-only">{t('dashboard.columns.tags')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((project) => (
                <tr
                  key={project.id}
                  className="border-b border-slate-100"
                  data-testid="project-row"
                >
                  <td className="py-2">
                    <input
                      type="checkbox"
                      aria-label={`${t('dashboard.columns.select')} ${project.name}`}
                      checked={dashboard.selected.has(project.id)}
                      onChange={() => {
                        dashboard.toggle(project.id);
                      }}
                    />
                  </td>
                  <td className="py-2">
                    {project.state === 'trashed' ? (
                      <span>{project.name}</span>
                    ) : (
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: project.id }}
                        className="font-medium text-accent hover:underline"
                      >
                        {project.name}
                      </Link>
                    )}
                    <span className="ml-2 inline-flex flex-wrap gap-1">
                      {project.tagIds.map((id) => {
                        const tag = tagById.get(id);
                        return tag ? <TagChip key={id} tag={tag} /> : null;
                      })}
                    </span>
                  </td>
                  <td className="hidden py-2 sm:table-cell">{project.owner.displayName}</td>
                  <td className="py-2 whitespace-nowrap">
                    {dateFormat.format(new Date(project.updatedAt))}
                  </td>
                  <td className="py-2 text-right">
                    <TagMenu project={project} tags={tags} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <aside>
        <TagManager tags={tags} />
      </aside>
    </div>
  );
}
