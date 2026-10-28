// Per-user UI preferences, stored in the user's `settings` record (PUT /user/me shallow-merges
// it, and UserSettings keeps unknown keys). Pure: no React here, so formatters can import it.
// The hook lives in hooks/ui-preferences.ts; AuthProvider keeps the active copy in sync.
import { t, getLocale } from '../i18n/store.js';
import { isLocaleCode, type LocaleSetting } from '../i18n/locales-meta.js';
import type { ReduceMotionSetting } from '../arclight/motion-preference.js';

export type WeekStartDay = 0 | 1;
export type TimeFormat = '24h' | '12h';
export type DateFormat = 'locale' | 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'D MMM YYYY';

export interface UiPreferences {
  /** 0 = Sunday, 1 = Monday. */
  firstDayOfWeek: WeekStartDay;
  timeFormat: TimeFormat;
  /** 'locale' follows the browser's locale (the medium date style). */
  dateFormat: DateFormat;
  /** Library poster grid columns (5-10, the library size slider's range). */
  posterColumns: number;
  /** UI language: a shipped locale, or 'auto' (this device's choice → browser → English). */
  locale: LocaleSetting;
  /** "Reduce motion": 'system' follows prefers-reduced-motion; 'on' / 'off' override it. */
  reduceMotion: ReduceMotionSetting;
  /** Theme pack id, or 'default' (the server's default theme). */
  theme: string;
}

export const POSTER_COLUMNS_MIN = 5;
export const POSTER_COLUMNS_MAX = 10;

export const DEFAULT_UI_PREFERENCES: Readonly<UiPreferences> = Object.freeze({
  firstDayOfWeek: 1,
  timeFormat: '24h',
  dateFormat: 'locale',
  posterColumns: 7,
  locale: 'auto',
  reduceMotion: 'system',
  theme: 'default',
});

export const DATE_FORMATS: ReadonlyArray<{ value: DateFormat; label: string }> = [
  { value: 'locale', get label() { return t('lib.uiPreferences.browserDefault'); } },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
  { value: 'D MMM YYYY', label: 'D MMM YYYY' },
];

const DATE_FORMAT_VALUES = new Set<string>(DATE_FORMATS.map((f) => f.value));

/** Reads preferences out of a user's settings record; anything missing or invalid falls back to the default. */
export function readUiPreferences(settings: Readonly<Record<string, unknown>> | null | undefined): UiPreferences {
  const s = settings ?? {};
  const cols = typeof s.posterColumns === 'number' && Number.isFinite(s.posterColumns) ? Math.round(s.posterColumns) : NaN;
  return {
    firstDayOfWeek: s.firstDayOfWeek === 0 || s.firstDayOfWeek === 1 ? s.firstDayOfWeek : DEFAULT_UI_PREFERENCES.firstDayOfWeek,
    timeFormat: s.timeFormat === '12h' || s.timeFormat === '24h' ? s.timeFormat : DEFAULT_UI_PREFERENCES.timeFormat,
    dateFormat: typeof s.dateFormat === 'string' && DATE_FORMAT_VALUES.has(s.dateFormat) ? (s.dateFormat as DateFormat) : DEFAULT_UI_PREFERENCES.dateFormat,
    posterColumns: cols >= POSTER_COLUMNS_MIN && cols <= POSTER_COLUMNS_MAX ? cols : DEFAULT_UI_PREFERENCES.posterColumns,
    locale: s.locale === 'auto' || isLocaleCode(s.locale) ? s.locale : DEFAULT_UI_PREFERENCES.locale,
    reduceMotion: s.reduceMotion === 'on' || s.reduceMotion === 'off' || s.reduceMotion === 'system' ? s.reduceMotion : DEFAULT_UI_PREFERENCES.reduceMotion,
    theme: typeof s.theme === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(s.theme) ? s.theme : DEFAULT_UI_PREFERENCES.theme,
  };
}

// The signed-in user's preferences, for the plain formatter functions used by tables.
let active: UiPreferences = { ...DEFAULT_UI_PREFERENCES };

export function setActiveUiPreferences(prefs: UiPreferences): void {
  active = prefs;
}

export function getActiveUiPreferences(): UiPreferences {
  return active;
}

export type DateInput = Date | string | number;

/** "YYYY-MM-DD" is a calendar date (local midnight); anything else goes through Date. */
export function toDate(value: DateInput): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Intl locale for dates: the UI language. English keeps the browser's own regional style
 * (en-GB and en-US users both read English), other languages use their own conventions.
 */
function dateLocale(locale: string): string | undefined {
  return locale === 'en' ? undefined : locale;
}

function dateOf(d: Date, format: DateFormat, locale: string): string {
  switch (format) {
    case 'YYYY-MM-DD':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    case 'DD/MM/YYYY':
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    case 'MM/DD/YYYY':
      return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
    case 'D MMM YYYY':
      return `${d.getDate()} ${d.toLocaleDateString(locale === 'en' ? 'en-GB' : locale, { month: 'short' })} ${d.getFullYear()}`;
    default:
      return d.toLocaleDateString(dateLocale(locale), { dateStyle: 'medium' });
  }
}

const periodCache = new Map<string, string>();

/** "AM"/"PM" in the UI language (Intl dayPeriod; English stays AM/PM). */
function dayPeriod(hours: number, locale: string): string {
  const am = hours < 12;
  if (locale === 'en') return am ? 'AM' : 'PM';
  const id = `${locale}:${am}`;
  let v = periodCache.get(id);
  if (v === undefined) {
    const parts = new Intl.DateTimeFormat(locale, { hour: 'numeric', hourCycle: 'h12' }).formatToParts(new Date(2026, 0, 1, am ? 9 : 21));
    v = parts.find((p) => p.type === 'dayPeriod')?.value ?? (am ? 'AM' : 'PM');
    periodCache.set(id, v);
  }
  return v;
}

/** Hours and minutes: "21:05" (24h) or "9:05 PM" (12h), the period in the UI language. */
export function clockLabel(hours: number, minutes: number, format: TimeFormat, locale: string = getLocale()): string {
  if (format === '24h') return `${pad(hours)}:${pad(minutes)}`;
  const h = hours % 12 === 0 ? 12 : hours % 12;
  return `${h}:${pad(minutes)} ${dayPeriod(hours, locale)}`;
}

/** An hour-axis label: "21:00" (24h) or "9 PM" (12h). */
export function hourLabel(hour: number, format: TimeFormat, locale: string = getLocale()): string {
  if (format === '24h') return `${pad(hour)}:00`;
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${dayPeriod(hour, locale)}`;
}

/** A date in the preferred format; "—" for empty input, the raw string when unparseable. */
export function formatDate(value: DateInput | null | undefined, prefs: Pick<UiPreferences, 'dateFormat'> = active, locale: string = getLocale()): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = toDate(value);
  return d ? dateOf(d, prefs.dateFormat, locale) : String(value);
}

/** A time of day in the preferred format. */
export function formatTime(value: DateInput | null | undefined, prefs: Pick<UiPreferences, 'timeFormat'> = active, locale: string = getLocale()): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = toDate(value);
  return d ? clockLabel(d.getHours(), d.getMinutes(), prefs.timeFormat, locale) : String(value);
}

/** Date and time: "2026-10-20 21:05". */
export function formatDateTime(
  value: DateInput | null | undefined,
  prefs: Pick<UiPreferences, 'dateFormat' | 'timeFormat'> = active,
  locale: string = getLocale(),
): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = toDate(value);
  return d ? `${dateOf(d, prefs.dateFormat, locale)} ${clockLabel(d.getHours(), d.getMinutes(), prefs.timeFormat, locale)}` : String(value);
}
