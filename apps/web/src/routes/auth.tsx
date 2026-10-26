import type { PublicUser } from '@galley/shared';
import { useMutation } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ErrorAlert, TextField, useFieldError } from '../components/ui.js';
import { api, ApiRequestError } from '../lib/api.js';
import { useAuthConfig, useRefreshSession, useSession } from '../lib/session.js';

function formValues(event: {
  preventDefault: () => void;
  currentTarget: HTMLFormElement;
}): Record<string, string> {
  event.preventDefault();
  const values: Record<string, string> = {};
  for (const [key, value] of new FormData(event.currentTarget)) {
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}

/** Signs in through `path` and opens the dashboard. */
function useAuthMutation(path: string) {
  const refresh = useRefreshSession();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<{ user: PublicUser }>('POST', path, { json: body }),
    onSuccess: async () => {
      await refresh();
      await navigate({ to: '/projects' });
    },
  });
}

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="font-serif text-3xl font-semibold">{title}</h1>
      {children}
    </div>
  );
}

/** Error shown above the form; field errors are shown next to their input. */
function FormError({ error }: { error: unknown }) {
  if (error instanceof ApiRequestError && error.fields.length > 0) return null;
  return <ErrorAlert error={error} />;
}

function RedirectWhenSignedIn() {
  const { user } = useSession();
  return user ? <Navigate to="/projects" /> : null;
}

export function LoginPage() {
  const { t } = useTranslation();
  const login = useAuthMutation('/api/auth/login');
  const config = useAuthConfig();
  if (config.data?.setupRequired) return <Navigate to="/setup" />;
  return (
    <AuthCard title={t('auth.login.title')}>
      <RedirectWhenSignedIn />
      <form
        className="space-y-4"
        onSubmit={(event) => {
          login.mutate(formValues(event));
        }}
      >
        <TextField label={t('auth.fields.login')} name="login" autoComplete="username" required />
        <TextField
          label={t('auth.fields.password')}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <ErrorAlert error={login.error} />
        <Button type="submit" variant="primary" className="w-full" disabled={login.isPending}>
          {t('auth.login.submit')}
        </Button>
      </form>
      {config.data?.registrationMode === 'open' && (
        <p className="text-sm">
          {t('auth.login.noAccount')}{' '}
          <Link to="/register" className="underline">
            {t('auth.login.register')}
          </Link>
        </p>
      )}
    </AuthCard>
  );
}

export function RegisterPage() {
  const { t } = useTranslation();
  const { invite } = useSearch({ from: '/register' });
  const register = useAuthMutation('/api/auth/register');
  const fieldError = useFieldError(register.error);
  const config = useAuthConfig();
  const mode = config.data?.registrationMode;
  const blocked = mode === 'closed' || (mode === 'invite' && invite === undefined);
  return (
    <AuthCard title={t('auth.register.title')}>
      <RedirectWhenSignedIn />
      {blocked ? (
        <p className="rounded-md bg-slate-100 px-3 py-2 text-sm">
          {mode === 'closed' ? t('auth.register.closed') : t('auth.register.inviteRequired')}
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            const values = formValues(event);
            register.mutate(invite === undefined ? values : { ...values, inviteToken: invite });
          }}
        >
          <TextField
            label={t('auth.fields.displayName')}
            name="displayName"
            autoComplete="name"
            required
            error={fieldError('displayName')}
          />
          <TextField
            label={t('auth.fields.email')}
            name="email"
            type="email"
            autoComplete="email"
            required
            error={fieldError('email')}
          />
          <TextField
            label={t('auth.fields.username')}
            name="username"
            autoComplete="username"
            required
            error={fieldError('username')}
          />
          <TextField
            label={t('auth.fields.password')}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            hint={t('auth.fields.passwordHint')}
            error={fieldError('password')}
          />
          <FormError error={register.error} />
          <Button type="submit" variant="primary" className="w-full" disabled={register.isPending}>
            {t('auth.register.submit')}
          </Button>
        </form>
      )}
      <p className="text-sm">
        {t('auth.register.haveAccount')}{' '}
        <Link to="/login" className="underline">
          {t('auth.register.login')}
        </Link>
      </p>
    </AuthCard>
  );
}

export function SetupPage() {
  const { t } = useTranslation();
  const setup = useAuthMutation('/api/auth/setup');
  const fieldError = useFieldError(setup.error);
  const config = useAuthConfig();
  if (config.data && !config.data.setupRequired) return <Navigate to="/login" />;
  return (
    <AuthCard title={t('auth.setup.title')}>
      <p className="text-sm text-slate-700">{t('auth.setup.intro')}</p>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          setup.mutate(formValues(event));
        }}
      >
        <TextField
          label={t('auth.fields.setupCode')}
          name="setupCode"
          autoComplete="off"
          required
          error={fieldError('setupCode')}
        />
        <TextField
          label={t('auth.fields.displayName')}
          name="displayName"
          autoComplete="name"
          required
          error={fieldError('displayName')}
        />
        <TextField
          label={t('auth.fields.email')}
          name="email"
          type="email"
          autoComplete="email"
          required
          error={fieldError('email')}
        />
        <TextField
          label={t('auth.fields.username')}
          name="username"
          autoComplete="username"
          required
          error={fieldError('username')}
        />
        <TextField
          label={t('auth.fields.password')}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          hint={t('auth.fields.passwordHint')}
          error={fieldError('password')}
        />
        <FormError error={setup.error} />
        <Button type="submit" variant="primary" className="w-full" disabled={setup.isPending}>
          {t('auth.setup.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}

/** `/`: dashboard when signed in, otherwise sign-in or first-run setup. */
export function IndexRedirect() {
  const { user, isLoading } = useSession();
  const config = useAuthConfig();
  if (isLoading || config.isLoading) return null;
  if (user) return <Navigate to="/projects" />;
  return <Navigate to={config.data?.setupRequired ? '/setup' : '/login'} />;
}

/** Renders its children for signed-in users and sends others to the sign-in page. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useSession();
  const { t } = useTranslation();
  if (isLoading) return <p className="text-slate-600">{t('common.loading')}</p>;
  return user ? children : <Navigate to="/login" />;
}
