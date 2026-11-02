import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePreferences } from '../stores/editor.js';

/** Switches the whole interface, editor included, between day and night. */
export function ThemeToggle() {
  const { t } = useTranslation();
  const { theme, setTheme } = usePreferences();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      aria-pressed={dark}
      aria-label={t('theme.night')}
      title={dark ? t('theme.toLight') : t('theme.toDark')}
      onClick={() => {
        setTheme(dark ? 'light' : 'dark');
      }}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100"
    >
      {dark ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
    </button>
  );
}
