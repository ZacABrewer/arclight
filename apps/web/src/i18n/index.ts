// Arclight i18n: a dependency-free translation layer.
//   t('library.addSeries')                    plain text
//   t('queue.count', { count })               ICU-lite plural/select (message-format.ts)
//   const t = useT()                          same, re-rendering on locale change
//   <Trans k="health.fixLink" components={{ link: <Link to="/settings" /> }} />
// English (locales/en.json) is the source of truth; see docs/TRANSLATING.md.
export {
  t,
  getLocale,
  intlLocale,
  setLocale,
  hasKey,
  subscribeLocale,
  detectLocale,
  deviceLocale,
  rememberDeviceLocale,
  applyLocaleSetting,
  chooseLocale,
  browserLocales,
  registerMessages,
  configureMissingKeyWarning,
  type Messages,
} from './store.js';
export { useT, useLocale, I18nProvider, Trans, renderRich, type TransProps } from './react.js';
export { formatMessage, parseMessage, messageParams, MessageSyntaxError, type MessageParams } from './message-format.js';
export { LOCALES, SOURCE_LOCALE, isLocaleCode, localeDir, matchLocale, type LocaleCode, type LocaleSetting } from './locales-meta.js';
export * from './format.js';
