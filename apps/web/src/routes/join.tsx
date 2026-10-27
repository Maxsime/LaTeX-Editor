import { hasRole } from '@galley/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button, ErrorAlert } from '../components/ui.js';
import { useJoinLink, useLinkPreview } from '../lib/sharing.js';

/** Landing page of a share link: names the project and the offered role, then joins. */
export function JoinPage() {
  const { t } = useTranslation();
  const { token } = useParams({ from: '/join/$token' });
  const preview = useLinkPreview(token);
  const join = useJoinLink(token);
  const navigate = useNavigate();
  const open = (projectId: string) =>
    void navigate({ to: '/projects/$projectId', params: { projectId } });

  if (preview.isLoading) return <p className="text-slate-600">{t('common.loading')}</p>;
  if (preview.error || !preview.data) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <h1 className="font-serif text-2xl font-semibold">{t('join.title')}</h1>
        <ErrorAlert error={preview.error} />
        <Link to="/projects" className="text-sm text-accent underline">
          {t('project.back')}
        </Link>
      </div>
    );
  }
  const { project, role, currentRole } = preview.data;
  // A link never lowers a role: a member with at least as much access just opens the project.
  const covered = currentRole !== null && hasRole(currentRole, role);
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="font-serif text-2xl font-semibold">{t('join.title')}</h1>
      <p>
        {covered
          ? t('join.alreadyMember', { project: project.name, role: t(`roles.${currentRole}`) })
          : t('join.offer', {
              project: project.name,
              role: t(`roles.${role}`).toLocaleLowerCase(),
            })}
      </p>
      <ErrorAlert error={join.error} />
      {covered ? (
        <Button
          variant="primary"
          onClick={() => {
            open(project.id);
          }}
        >
          {t('join.open')}
        </Button>
      ) : (
        <Button
          variant="primary"
          disabled={join.isPending}
          onClick={() => {
            join.mutate(undefined, {
              onSuccess: ({ projectId }) => {
                open(projectId);
              },
            });
          }}
        >
          {t('join.submit')}
        </Button>
      )}
    </div>
  );
}
