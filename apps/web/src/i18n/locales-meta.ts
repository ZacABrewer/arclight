// Locales the app ships. `en` is the source of truth (locales/en.json); every other file is
// generated from it by scripts/i18n-locales.mjs and translated by contributors.
// Pure data: lib/ui-preferences.ts imports this to validate the stored `locale` setting.

export const SOURCE_LOCALE = 'en';

export const LOCALES = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
] as const;

export type LocaleCode = (typeof LOCALES)[number]['code'];

/** The stored preference: a locale, or `auto` (device choice → browser → English). */
export type LocaleSetting = LocaleCode | 'auto';

const CODES = new Set<string>(LOCALES.map((l) => l.code));

export function isLocaleCode(v: unknown): v is LocaleCode {
  return typeof v === 'string' && CODES.has(v);
}

// Scripts written right to left. None ships yet; `ar` and friends get dir="rtl" the day a
// locale file for them lands, and the shell's CSS uses logical properties to follow.
const RTL = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'yi', 'dv', 'ckb']);

export function localeDir(locale: string): 'ltr' | 'rtl' {
  return RTL.has(locale.split('-')[0]!.toLowerCase()) ? 'rtl' : 'ltr';
}

/**
 * Best shipped locale for a list of BCP-47 tags (navigator.languages): exact match first,
 * then the language part ("de-AT" → "de"). Undefined when nothing matches.
 */
export function matchLocale(tags: readonly string[]): LocaleCode | undefined {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (isLocaleCode(lower)) return lower;
    const lang = lower.split('-')[0];
    if (isLocaleCode(lang)) return lang;
  }
  return undefined;
}
