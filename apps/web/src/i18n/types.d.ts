import 'i18next';
import type fr from './locales/fr.json';

// Type-checks translation keys against the French catalogue, the reference language.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof fr };
  }
}
