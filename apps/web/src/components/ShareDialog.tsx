import {
  type ProjectDetails,
  type ProjectMember,
  type SharedRole,
  sharedRole,
} from '@galley/shared';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { joinPath, useMembers, useSharing, useSharingMutations } from '../lib/sharing.js';
import { useSession } from '../lib/session.js';
import { Button, ConfirmDialog, Dialog, ErrorAlert, TextField } from './ui.js';

const ROLES = sharedRole.options;
const EXPIRY_DAYS = [0, 7, 30, 90] as const;

/** Text value of a form field. */
function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function RoleSelect({
  label,
  value,
  onChange,
  name,
  disabled = false,
}: {
  label: string;
  value?: SharedRole;
  onChange?: (role: SharedRole) => void;
  name?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <select
      aria-label={label}
      name={name}
      disabled={disabled}
      {...(value === undefined ? { defaultValue: 'editor' } : { value })}
      onChange={(event) => {
        const role = ROLES.find((item) => item === event.currentTarget.value);
        if (role && onChange) onChange(role);
      }}
      className="rounded-md border border-slate-300 px-2 py-1 text-sm"
    >
      {ROLES.map((role) => (
        <option key={role} value={role}>
          {t(`roles.${role}`)}
        </option>
      ))}
    </select>
  );
}

type Pending = { kind: 'remove' | 'transfer'; member: ProjectMember } | { kind: 'leave' };

function MemberList({ project }: { project: ProjectDetails }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const navigate = useNavigate();
  const members = useMembers(project.id);
  const mutations = useSharingMutations(project.id);
  const [pending, setPending] = useState<Pending | null>(null);
  const isOwner = project.role === 'owner';
  const confirm = (): void => {
    if (pending === null) return;
    if (pending.kind === 'leave') {
      if (!user) return;
      mutations.removeMember.mutate(user.id, {
        onSuccess: () => void navigate({ to: '/projects' }),
      });
      return;
    }
    const mutation = pending.kind === 'remove' ? mutations.removeMember : mutations.transfer;
    mutation.mutate(pending.member.userId, {
      onSuccess: () => {
        setPending(null);
      },
    });
  };
  const error =
    members.error ??
    mutations.setRole.error ??
    mutations.removeMember.error ??
    mutations.transfer.error;

  return (
    <section aria-labelledby="members-title" className="space-y-2">
      <h3 id="members-title" className="text-sm font-semibold">
        {t('share.members.title')}
      </h3>
      <ul className="divide-y divide-slate-100 text-sm" aria-label={t('share.members.title')}>
        {(members.data ?? []).map((member) => {
          const self = member.userId === user?.id;
          return (
            <li key={member.userId} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="mr-auto min-w-0">
                <span className="font-medium">{member.displayName}</span>{' '}
                <span className="text-slate-600">@{member.username}</span>
                {member.email !== null && (
                  <span className="block text-xs text-slate-600">{member.email}</span>
                )}
              </span>
              {isOwner && member.role !== 'owner' ? (
                <>
                  <RoleSelect
                    label={t('share.members.role', { name: member.displayName })}
                    value={member.role}
                    disabled={mutations.setRole.isPending}
                    onChange={(role) => {
                      mutations.setRole.mutate({ userId: member.userId, role });
                    }}
                  />
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setPending({ kind: 'transfer', member });
                    }}
                  >
                    {t('share.members.transfer')}
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-red-700"
                    onClick={() => {
                      setPending({ kind: 'remove', member });
                    }}
                  >
                    {t('share.members.remove')}
                  </Button>
                </>
              ) : (
                <span className="text-slate-700">{t(`roles.${member.role}`)}</span>
              )}
              {self && member.role !== 'owner' && (
                <Button
                  variant="ghost"
                  className="text-red-700"
                  onClick={() => {
                    setPending({ kind: 'leave' });
                  }}
                >
                  {t('share.members.leave')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorAlert error={error} />
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending === null ? '' : t(`share.members.${pending.kind}`)}
        description={
          pending === null
            ? ''
            : pending.kind === 'leave'
              ? t('share.members.confirmLeave', { project: project.name })
              : t(
                  pending.kind === 'remove'
                    ? 'share.members.confirmRemove'
                    : 'share.members.confirmTransfer',
                  { name: pending.member.displayName },
                )
        }
        confirmLabel={pending === null ? '' : t(`share.members.${pending.kind}`)}
        pending={mutations.removeMember.isPending || mutations.transfer.isPending}
        onConfirm={confirm}
      />
    </section>
  );
}

function Invitations({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { invites } = useSharing(projectId, true);
  const mutations = useSharingMutations(projectId);
  return (
    <section aria-labelledby="invite-title" className="space-y-2">
      <h3 id="invite-title" className="text-sm font-semibold">
        {t('share.invite.title')}
      </h3>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const role = ROLES.find((item) => item === field(data, 'role')) ?? 'editor';
          mutations.invite.mutate(
            { identifier: field(data, 'identifier').trim(), role },
            {
              onSuccess: () => {
                form.reset();
              },
            },
          );
        }}
      >
        <div className="min-w-48 flex-1">
          <TextField
            label={t('share.invite.identifier')}
            name="identifier"
            maxLength={320}
            required
          />
        </div>
        <RoleSelect label={t('share.invite.role')} name="role" />
        <Button type="submit" variant="primary" disabled={mutations.invite.isPending}>
          {t('share.invite.submit')}
        </Button>
      </form>
      <p className="text-xs text-slate-600">{t('share.invite.hint')}</p>
      <ErrorAlert error={mutations.invite.error ?? mutations.cancelInvite.error} />
      {(invites.data ?? []).length > 0 && (
        <ul className="divide-y divide-slate-100 text-sm" aria-label={t('share.invite.pending')}>
          {(invites.data ?? []).map((invite) => (
            <li key={invite.id} className="flex items-center gap-2 py-1.5">
              <span className="mr-auto">
                {invite.user.displayName}{' '}
                <span className="text-slate-600">@{invite.user.username}</span>
              </span>
              <span className="text-slate-700">
                {t('share.invite.pendingRole', {
                  role: t(`roles.${invite.role}`).toLocaleLowerCase(),
                })}
              </span>
              <Button
                variant="ghost"
                onClick={() => {
                  mutations.cancelInvite.mutate(invite.id);
                }}
              >
                {t('share.invite.cancel')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ShareLinks({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const { links } = useSharing(projectId, true);
  const mutations = useSharingMutations(projectId);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const urlId = useId();
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' });
  return (
    <section aria-labelledby="links-title" className="space-y-2">
      <h3 id="links-title" className="text-sm font-semibold">
        {t('share.links.title')}
      </h3>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const role = ROLES.find((item) => item === field(data, 'role')) ?? 'reader';
          const days = Number(field(data, 'expiry'));
          mutations.createLink.mutate(days > 0 ? { role, expiresInDays: days } : { role }, {
            onSuccess: ({ token }) => {
              setCopied(false);
              setCreated(`${window.location.origin}${joinPath(token)}`);
            },
          });
        }}
      >
        <RoleSelect label={t('share.links.role')} name="role" />
        <select
          name="expiry"
          aria-label={t('share.links.expiry')}
          defaultValue="0"
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
        >
          {EXPIRY_DAYS.map((days) => (
            <option key={days} value={days}>
              {days === 0 ? t('share.links.never') : t('share.links.days', { count: days })}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={mutations.createLink.isPending}>
          {t('share.links.create')}
        </Button>
      </form>
      {created !== null && (
        <div className="space-y-1 rounded-md bg-slate-50 p-2">
          <label htmlFor={urlId} className="block text-xs font-medium">
            {t('share.links.created')}
          </label>
          <div className="flex gap-2">
            <input
              id={urlId}
              readOnly
              value={created}
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs"
            />
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(created).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? t('share.links.copied') : t('share.links.copy')}
            </Button>
          </div>
          <p className="text-xs text-slate-600">{t('share.links.once')}</p>
        </div>
      )}
      <ErrorAlert error={mutations.createLink.error ?? mutations.revokeLink.error} />
      {(links.data ?? []).length > 0 && (
        <ul className="divide-y divide-slate-100 text-sm" aria-label={t('share.links.active')}>
          {(links.data ?? []).map((link) => (
            <li key={link.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="mr-auto">
                {t(`roles.${link.role}`)}
                <span className="ml-2 text-xs text-slate-600">
                  {link.expiresAt === null
                    ? t('share.links.noExpiry')
                    : t('share.links.expires', { date: date.format(new Date(link.expiresAt)) })}
                  {' · '}
                  {t('share.links.uses', { count: link.uses })}
                </span>
              </span>
              <Button
                variant="ghost"
                className="text-red-700"
                onClick={() => {
                  mutations.revokeLink.mutate(link.id);
                }}
              >
                {t('share.links.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Members of a project and, for its owner, invitations and share links.
 * Every other member sees who has access and can leave.
 */
export function ShareDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectDetails;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const isOwner = project.role === 'owner';
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('share.title', { project: project.name })}
      wide
    >
      <MemberList project={project} />
      {isOwner && <Invitations projectId={project.id} />}
      {isOwner && <ShareLinks projectId={project.id} />}
      <div className="flex justify-end">
        <Button
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('common.close')}
        </Button>
      </div>
    </Dialog>
  );
}
