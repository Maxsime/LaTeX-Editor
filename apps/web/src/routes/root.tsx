import { useMutation } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '../components/LanguageSwitcher.js';
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
  return (
    <div className="flex min-h-screen flex-col bg-white text-ink">
      <header className="flex items-center gap-4 border-b border-slate-200 px-6 py-3">
        <Link to="/" className="font-serif text-xl font-semibold text-accent">
          {t('app.name')}
        </Link>
        <div className="ml-auto flex items-center gap-3">
          <UserMenu />
          <LanguageSwitcher />
        </div>
      </header>
      <main
        className={wide ? 'w-full flex-1 px-4 py-4' : 'mx-auto w-full max-w-6xl flex-1 px-6 py-8'}
      >
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 px-6 py-3 text-center text-xs text-slate-600">
        {t('footer.license')}{' '}
        <a className="underline" href={SOURCE_URL} rel="noreferrer" target="_blank">
          {t('footer.source')}
        </a>{' '}
        ·{' '}
        <Link to="/status" className="underline">
          {t('nav.status')}
        </Link>
      </footer>
    </div>
  );
}
