import { ToggleGroup } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import { supportedLanguages, toSupportedLanguage } from '../i18n/index.js';

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = toSupportedLanguage(i18n.resolvedLanguage);

  return (
    <ToggleGroup.Root
      type="single"
      value={current}
      aria-label={t('language.label')}
      className="inline-flex rounded-md border border-slate-300 p-0.5 text-sm"
      onValueChange={(value) => {
        // Radix reports an empty value when the active item is clicked again; keep the language.
        if (value) void i18n.changeLanguage(value);
      }}
    >
      {supportedLanguages.map((language) => (
        <ToggleGroup.Item
          key={language}
          value={language}
          lang={language}
          className="rounded px-2 py-1 text-slate-700 data-[state=on]:bg-accent data-[state=on]:text-white"
        >
          {t(`language.${language}`)}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
