import { getActiveUiPreferences, type WeekStartDay } from '../lib/ui-preferences.js';
import { getLocale } from './store.js';

// Locale-aware number, size, duration and date helpers. Dates and times live in
// lib/ui-preferences.ts (they honour the user's date format, 12/24h clock and the active
// locale) and are re-exported here so pages have one import for formatting.
export { formatDate, formatDateTime, formatTime, clockLabel, hourLabel } from '../lib/ui-preferences.js';

const cache = new Map<string, Intl.NumberFormat>();

function nf(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const id = `${locale}|${JSON.stringify(opts)}`;
  let f = cache.get(id);
  if (!f) cache.set(id, (f = new Intl.NumberFormat(locale, opts)));
  return f;
}

/** A number in the active locale: 12,345.6 (en), 12.345,6 (de). */
export function formatNumber(n: number | null | undefined, opts: Intl.NumberFormatOptions = {}, locale: string = getLocale()): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return nf(locale, opts).format(n);
}

/**
 * A fixed-point number with the locale's decimal separator and no grouping: "1.5" (en),
 * "1,5" (de). English is exactly Number#toFixed, so existing mono layouts do not move.
 */
export function formatDecimal(n: number, digits: number, locale: string = getLocale()): string {
  if (locale === 'en') return n.toFixed(digits);
  return nf(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(n);
}

/** A 0..1 ratio as a percentage: 0.684 → "68%" (or "68.4%" with digits = 1). */
export function formatPercent(ratio: number | null | undefined, digits = 0, locale: string = getLocale()): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return nf(locale, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(ratio);
}

const BINARY = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const DECIMAL = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

/**
 * Bytes with a unit: "1.5 GiB" (binary, default) or "1.6 GB" (decimal). The number uses the
 * locale's decimal separator ("1,5 GiB" in de); unit symbols are international.
 */
export function formatBytes(
  bytes: number | null | undefined,
  opts: { binary?: boolean; digits?: number } = {},
  locale: string = getLocale(),
): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const base = opts.binary === false ? 1000 : 1024;
  const units = opts.binary === false ? DECIMAL : BINARY;
  let n = Math.max(0, bytes);
  let i = 0;
  while (n >= base && i < units.length - 1) {
    n /= base;
    i++;
  }
  const digits = i === 0 ? 0 : (opts.digits ?? 1);
  return `${nf(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(n)} ${units[i]}`;
}

type DurationUnit = 'day' | 'hour' | 'minute' | 'second';

function unit(n: number, u: DurationUnit, locale: string): string {
  return nf(locale, { style: 'unit', unit: u, unitDisplay: 'narrow' }).format(n);
}

/**
 * A duration as its two largest units, narrow: "3d 7h", "2h 5m", "4m 3s", "12s" (en). Under a
 * second shows milliseconds.
 */
export function formatDuration(ms: number | null | undefined, locale: string = getLocale()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (Math.abs(ms) < 1000) return nf(locale, { style: 'unit', unit: 'millisecond', unitDisplay: 'short' }).format(Math.round(ms));
  const total = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = d
    ? [unit(d, 'day', locale), unit(h, 'hour', locale)]
    : h
      ? [unit(h, 'hour', locale), unit(m, 'minute', locale)]
      : m
        ? [unit(m, 'minute', locale), unit(s, 'second', locale)]
        : [unit(s, 'second', locale)];
  return parts.join(' ');
}

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();

/** "5 minutes ago", "in 2 days" (Intl.RelativeTimeFormat, numeric: auto → "yesterday"). */
export function formatRelative(value: Date | string | number, now: number = Date.now(), locale: string = getLocale()): string {
  const at = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(at)) return '—';
  const diff = (at - now) / 1000;
  const abs = Math.abs(diff);
  let rtf = rtfCache.get(locale);
  if (!rtf) rtfCache.set(locale, (rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })));
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86_400 * 30) return rtf.format(Math.round(diff / 86_400), 'day');
  if (abs < 86_400 * 365) return rtf.format(Math.round(diff / (86_400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86_400 * 365)), 'year');
}

/**
 * Weekday names starting at the user's first day of week: ["Mon", ..., "Sun"] for Monday
 * starts. `style` is Intl's weekday width.
 */
export function weekdayNames(
  firstDay: WeekStartDay = getActiveUiPreferences().firstDayOfWeek,
  style: 'long' | 'short' | 'narrow' = 'short',
  locale: string = getLocale(),
): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: style });
  // 2026-01-04 is a Sunday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2026, 0, 4 + ((firstDay + i) % 7))));
}

/** Month names for the active locale. */
export function monthNames(style: 'long' | 'short' = 'long', locale: string = getLocale()): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { month: style });
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2026, i, 1)));
}

/** A list joined the locale's way: "A, B and C" (en), "A, B und C" (de). */
export function formatList(items: readonly string[], type: 'conjunction' | 'disjunction' = 'conjunction', locale: string = getLocale()): string {
  return new Intl.ListFormat(locale, { style: 'long', type }).format(items);
}
