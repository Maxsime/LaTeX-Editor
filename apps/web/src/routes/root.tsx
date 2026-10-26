import { Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '../components/LanguageSwitcher.js';
import { SOURCE_URL } from '../lib/config.js';

export function RootLayout() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col bg-white text-ink">
      <header className="flex items-center justify-between border-b border-slate-200 px-6 py-3">
        <span className="font-serif text-xl font-semibold text-accent">{t('app.name')}</span>
        <LanguageSwitcher />
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 px-6 py-3 text-center text-xs text-slate-600">
        {t('footer.license')}{' '}
        <a className="underline" href={SOURCE_URL} rel="noreferrer" target="_blank">
          {t('footer.source')}
        </a>
      </footer>
    </div>
  );
}
