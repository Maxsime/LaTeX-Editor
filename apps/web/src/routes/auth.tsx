import type { PublicUser } from '@galley/shared';
import { useMutation } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
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

/** Signs in through `path`, then opens `redirect` or the dashboard. */
function useAuthMutation(path: string, redirect?: string) {
  const refresh = useRefreshSession();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<{ user: PublicUser }>('POST', path, { json: body }),
    onSuccess: async () => {
      await refresh();
      await navigate({ to: redirect ?? '/projects' });
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

function RedirectWhenSignedIn({ to = '/projects' }: { to?: string }) {
  const { user } = useSession();
  return user ? <Navigate to={to} /> : null;
}

export function LoginPage() {
  const { t } = useTranslation();
  const { redirect, error } = useSearch({ from: '/login' });
  const login = useAuthMutation('/api/auth/login', redirect);
  const config = useAuthConfig();
  if (config.data?.setupRequired) return <Navigate to="/setup" />;
  const oidc = config.data?.oidc ?? null;
  return (
    <AuthCard title={t('auth.login.title')}>
      <RedirectWhenSignedIn {...(redirect === undefined ? {} : { to: redirect })} />
      {error !== undefined && <ErrorAlert error={new ApiRequestError(400, error)} />}
      {oidc !== null && (
        <>
          <a
            // A full navigation: the provider's page is not part of the application.
            href={`/api/auth/oidc/start${redirect === undefined ? '' : `?redirect=${encodeURIComponent(redirect)}`}`}
            className="inline-flex w-full items-center justify-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            {t('auth.login.oidc', { name: oidc.displayName })}
          </a>
          <p className="text-center text-xs text-slate-600">{t('auth.login.or')}</p>
        </>
      )}
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
      {config.data?.mail === true && (
        <p className="text-sm">
          <Link to="/forgot-password" className="underline">
            {t('auth.login.forgot')}
          </Link>
        </p>
      )}
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

/** Asks for a reset link; the answer is the same whether an account exists or not. */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const config = useAuthConfig();
  const request = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api('POST', '/api/auth/password-reset', { json: body }),
  });
  const fieldError = useFieldError(request.error);
  return (
    <AuthCard title={t('auth.forgot.title')}>
      <RedirectWhenSignedIn />
      {config.data?.mail === false ? (
        <p className="rounded-md bg-slate-100 px-3 py-2 text-sm">{t('auth.forgot.noMail')}</p>
      ) : request.isSuccess ? (
        <p role="status" className="rounded-md bg-slate-100 px-3 py-2 text-sm">
          {t('auth.forgot.sent')}
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            request.mutate(formValues(event));
          }}
        >
          <p className="text-sm text-slate-700">{t('auth.forgot.intro')}</p>
          <TextField
            label={t('auth.fields.email')}
            name="email"
            type="email"
            autoComplete="email"
            required
            error={fieldError('email')}
          />
          <FormError error={request.error} />
          <Button type="submit" variant="primary" className="w-full" disabled={request.isPending}>
            {t('auth.forgot.submit')}
          </Button>
        </form>
      )}
      <p className="text-sm">
        <Link to="/login" className="underline">
          {t('auth.register.login')}
        </Link>
      </p>
    </AuthCard>
  );
}

/** Sets a new password with the token of an e-mailed link. */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const { token } = useSearch({ from: '/reset-password' });
  const [mismatch, setMismatch] = useState(false);
  const reset = useMutation({
    mutationFn: (password: string) =>
      api('POST', '/api/auth/password-reset/confirm', { json: { token, password } }),
  });
  const fieldError = useFieldError(reset.error);
  return (
    <AuthCard title={t('auth.reset.title')}>
      {token === undefined ? (
        <p className="rounded-md bg-slate-100 px-3 py-2 text-sm">{t('auth.reset.noToken')}</p>
      ) : reset.isSuccess ? (
        <p role="status" className="rounded-md bg-slate-100 px-3 py-2 text-sm">
          {t('auth.reset.done')}
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            const { password = '', confirm = '' } = formValues(event);
            setMismatch(password !== confirm);
            if (password === confirm) reset.mutate(password);
          }}
        >
          <TextField
            label={t('auth.reset.password')}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            hint={t('auth.fields.passwordHint')}
            error={fieldError('password')}
          />
          <TextField
            label={t('auth.reset.confirm')}
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            error={mismatch ? t('auth.reset.mismatch') : undefined}
          />
          <FormError error={reset.error} />
          <Button type="submit" variant="primary" className="w-full" disabled={reset.isPending}>
            {t('auth.reset.submit')}
          </Button>
        </form>
      )}
      <p className="text-sm">
        <Link to="/login" className="underline">
          {t('auth.register.login')}
        </Link>
      </p>
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
/** Shows `children` to a signed-in user; others sign in first, then come back here. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useSession();
  const { t } = useTranslation();
  // Read once: subscribing to the location would re-render, and so re-run, the
  // redirection below at every step of the navigation it starts.
  const router = useRouter();
  const [here] = useState(() => router.state.location.href);
  if (isLoading) return <p className="text-slate-600">{t('common.loading')}</p>;
  if (user) return children;
  // The dashboard is where signing in leads anyway.
  return here === '/projects' ? (
    <Navigate to="/login" />
  ) : (
    <Navigate to="/login" search={{ redirect: here }} />
  );
}
