/**
 * i18n convention: react-i18next with statically bundled resources.
 *
 * - Default (and fallback) language is **English** — the e2e suite selects by
 *   visible EN text, so `en/common.json` strings are contract-stable.
 * - Detection order: localStorage (`i18nextLng`, written automatically on
 *   `changeLanguage`) → browser `navigator.language`.
 * - Keys are namespaced by feature (`users.*`, `auth.*`, `analytics.*`, …)
 *   plus `common.*` for cross-feature strings.
 * - zod validation messages: schemas are built inside the component with the
 *   `t` function (`makeSchema(t)`), memoized on `[t]` so messages re-resolve
 *   when the language changes. See LoginForm.tsx / UserModal.tsx.
 * - `<html lang>` is kept in sync via the `languageChanged` listener below.
 */
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en/common.json';
import zh from '../locales/zh/common.json';

const SUPPORTED_LANGUAGES = ['en', 'zh'] as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
    },
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false }, // React already escapes
  });

// Keep <html lang> in sync with the active language (a11y / screen readers).
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});
if (typeof document !== 'undefined' && i18n.resolvedLanguage) {
  document.documentElement.lang = i18n.resolvedLanguage;
}
