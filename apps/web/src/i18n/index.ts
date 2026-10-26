import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import fr from './locales/fr.json';

export const supportedLanguages = ['fr', 'en'] as const;
export type Language = (typeof supportedLanguages)[number];

export const resources = { fr: { translation: fr }, en: { translation: en } } as const;

/** Narrows a detected or stored language tag to a supported language, French by default. */
export function toSupportedLanguage(tag: string | undefined): Language {
  const base = tag?.toLowerCase().split('-')[0];
  return supportedLanguages.find((language) => language === base) ?? 'fr';
}

// Registered before init so the language detected at startup is applied too.
i18n.on('languageChanged', (language) => {
  document.documentElement.lang = toSupportedLanguage(language);
});

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'fr',
    supportedLngs: supportedLanguages,
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'galley.language',
      caches: ['localStorage'],
    },
  });

export default i18n;
