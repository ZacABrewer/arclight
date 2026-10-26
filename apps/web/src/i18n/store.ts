import en from './locales/en.json';
import { formatMessage, type MessageParams } from './message-format.js';
import { SOURCE_LOCALE, isLocaleCode, localeDir, matchLocale, type LocaleCode, type LocaleSetting } from './locales-meta.js';

// The active locale and its messages. English is bundled (it is the fallback for every
// missing key); other locales are separate chunks loaded on first use. `t` reads the active
// locale directly, so it works in components, hooks, model functions and module-level
// getters alike; the I18nProvider remounts the tree when the locale changes.

export type Messages = Readonly<Record<string, string>>;

const SOURCE: Messages = en as Messages;
const loaders = import.meta.glob<{ default: Messages }>(['./locales/*.json', '!./locales/en.json']);

const loaded = new Map<string, Messages>([[SOURCE_LOCALE, SOURCE]]);
let locale: LocaleCode = SOURCE_LOCALE;
let messages: Messages = SOURCE;
const listeners = new Set<() => void>();
const warned = new Set<string>();

/** Dev builds and tests warn once per missing key; production stays quiet. */
let warnMissing = import.meta.env.DEV;
const defaultOnMissing = (key: string, loc: string) => {
  console.warn(`[i18n] missing key "${key}"${loc === SOURCE_LOCALE ? '' : ` (locale ${loc})`}`);
};
let onMissing: (key: string, locale: string) => void = defaultOnMissing;

/** Turn the missing-key warning on/off or route it elsewhere (null restores console.warn). */
export function configureMissingKeyWarning(opts: { enabled?: boolean; handler?: ((key: string, locale: string) => void) | null }): void {
  if (opts.enabled !== undefined) warnMissing = opts.enabled;
  if (opts.handler !== undefined) onMissing = opts.handler ?? defaultOnMissing;
  warned.clear();
}

function missing(key: string, loc: string) {
  if (!warnMissing) return;
  const id = `${loc}:${key}`;
  if (warned.has(id)) return;
  warned.add(id);
  onMissing(key, loc);
}

/**
 * Translate `key` with ICU-lite params. Falls back to English, then to the key itself
 * (with a dev warning in both cases).
 */
export function t(key: string, params?: MessageParams): string {
  let msg = messages[key];
  if (msg === undefined) {
    msg = SOURCE[key];
    missing(key, msg === undefined ? SOURCE_LOCALE : locale);
    if (msg === undefined) return key;
  }
  return formatMessage(msg, params, locale);
}

/** True when `key` exists in the English source. */
export function hasKey(key: string): boolean {
  return key in SOURCE;
}

export function getLocale(): LocaleCode {
  return locale;
}

/**
 * Locale argument for Intl/toLocale*String calls: the UI language, except English returns
 * undefined so en-GB and en-US browsers keep their own date and number conventions.
 */
export function intlLocale(): string | undefined {
  return locale === SOURCE_LOCALE ? undefined : locale;
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function load(code: LocaleCode): Promise<Messages> {
  const hit = loaded.get(code);
  if (hit) return hit;
  const loader = loaders[`./locales/${code}.json`];
  if (!loader) return SOURCE;
  const mod = await loader();
  loaded.set(code, mod.default);
  return mod.default;
}

function applyDocument(code: LocaleCode) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = code;
  document.documentElement.dir = localeDir(code);
}

/** Switch the active locale (loading its messages first). Unknown codes fall back to English. */
export async function setLocale(code: string): Promise<LocaleCode> {
  const next: LocaleCode = isLocaleCode(code) ? code : SOURCE_LOCALE;
  const msgs = await load(next);
  if (next === locale && msgs === messages) return locale;
  locale = next;
  messages = msgs;
  applyDocument(next);
  for (const fn of listeners) fn();
  return locale;
}

/** Test/bootstrap hook: install messages for a locale without a network round trip. */
export function registerMessages(code: string, msgs: Messages): void {
  loaded.set(code, msgs);
  if (code === locale) messages = msgs;
}

// ---------------------------------------------------------------------------------------
// Detection: user setting → this device's choice → browser languages → English.
// ---------------------------------------------------------------------------------------

const DEVICE_KEY = 'arclight.locale';

/** The locale chosen on this device before sign-in (setup wizard, login), if any. */
export function deviceLocale(): LocaleCode | undefined {
  try {
    const v = globalThis.localStorage?.getItem(DEVICE_KEY);
    return isLocaleCode(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function rememberDeviceLocale(code: LocaleCode | undefined): void {
  try {
    if (code) globalThis.localStorage?.setItem(DEVICE_KEY, code);
    else globalThis.localStorage?.removeItem(DEVICE_KEY);
  } catch {
    // Private mode or storage disabled: the choice lasts for this visit only.
  }
}

export function browserLocales(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

export function detectLocale(setting?: LocaleSetting | undefined, browser: readonly string[] = browserLocales()): LocaleCode {
  if (setting && setting !== 'auto' && isLocaleCode(setting)) return setting;
  return deviceLocale() ?? matchLocale(browser) ?? SOURCE_LOCALE;
}

/** Apply a stored preference (the signed-in user's `locale`, or 'auto' when signed out). */
export function applyLocaleSetting(setting?: LocaleSetting | undefined): Promise<LocaleCode> {
  return setLocale(detectLocale(setting));
}

/**
 * A language picked before or outside a user account (setup wizard, Settings): remember it on
 * this device and switch now. 'auto' forgets the device choice.
 */
export function chooseLocale(setting: LocaleSetting): Promise<LocaleCode> {
  rememberDeviceLocale(setting === 'auto' ? undefined : setting);
  return applyLocaleSetting(setting);
}
