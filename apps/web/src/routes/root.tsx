import { useMutation } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '../components/LanguageSwitcher.js';
import { ThemeToggle } from '../components/ThemeToggle.js';
import { Button } from '../components/ui.js';
import { api } from '../lib/api.js';
import { SOURCE_URL } from '../lib/config.js';
import { useRefreshSession, useSession } from '../lib/session.js';

function UserMenu() {
  const { t } = useTranslation();
  const { user } = useSession();
  const refresh = useRefreshSession();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => api('POST', '/api/auth/logout'),
    onSettled: async () => {
      await refresh();
      await navigate({ to: '/login' });
    },
  });
  if (!user) return null;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="hidden text-slate-600 sm:inline">
        {t('nav.signedInAs', { name: user.displayName })}
      </span>
      {user.isAdmin && (
        <Link to="/admin" className="text-ink hover:underline">
          {t('nav.admin')}
        </Link>
      )}
      <Link to="/account" className="text-ink hover:underline">
        {t('nav.account')}
      </Link>
      <Button
        variant="ghost"
        onClick={() => {
          logout.mutate();
        }}
      >
        {t('nav.logout')}
      </Button>
    </div>
  );
}

export function RootLayout() {
  const { t } = useTranslation();
  // The editor uses the whole window width; other pages keep a readable measure.
  const wide = useRouterState({
    select: (state) => state.location.pathname.startsWith('/projects/'),
  });
  // The detached PDF window fills its window, without the site's header and footer.
  const bare = useRouterState({
    select: (state) => /^\/projects\/[^/]+\/pdf$/.test(state.location.pathname),
  });
  if (bare) return <Outlet />;
  const sourceLinks = (
    <>
      {t('footer.license')}{' '}
      <a className="underline" href={SOURCE_URL} rel="noreferrer" target="_blank">
        {t('footer.source')}
      </a>{' '}
      ·{' '}
      <Link to="/status" className="underline">
        {t('nav.status')}
      </Link>
    </>
  );
  // The project page is a workspace: it fills the window and scrolls inside its panes.
  if (wide)
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-white text-ink">
        <header className="flex items-center gap-4 border-b border-slate-200 px-4 py-1">
          <Link to="/" className="font-serif text-lg font-semibold text-accent">
            {t('app.name')}
          </Link>
          <div className="ml-auto flex items-center gap-3">
            {/* AGPL: the source stays one click away, even in the workspace. */}
            <span className="text-xs text-slate-500">
              <span className="hidden xl:inline">{t('footer.license')} </span>
              <a className="underline" href={SOURCE_URL} rel="noreferrer" target="_blank">
                {t('footer.source')}
              </a>
            </span>
            <UserMenu />
            <ThemeToggle />
            <LanguageSwitcher />
          </div>
        </header>
        <main className="flex min-h-0 w-full flex-1 flex-col px-3 py-2">
          <Outlet />
        </main>
      </div>
    );
  return (
    <div className="flex min-h-screen flex-col bg-white text-ink">
      <header className="flex items-center gap-4 border-b border-slate-200 px-6 py-3">
        <Link to="/" className="font-serif text-xl font-semibold text-accent">
          {t('app.name')}
        </Link>
        <div className="ml-auto flex items-center gap-3">
          <UserMenu />
          <ThemeToggle />
          <LanguageSwitcher />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 px-6 py-3 text-center text-xs text-slate-600">
        {sourceLinks}
      </footer>
    </div>
  );
}
