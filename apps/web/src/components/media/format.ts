import type { MediaImage } from '@arclight/shared';
import { formatDate as formatPreferredDate, formatDateTime as formatPreferredDateTime } from '../../lib/ui-preferences.js';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1536 -> "1.5 KB". Binary multiples, as file managers show them. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return bytes === 0 ? '0 B' : '—';
  const exp = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exp;
  return `${value >= 100 || exp === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[exp]}`;
}

/**
 * Date-only strings (YYYY-MM-DD) are calendar dates, not instants: format them without a
 * timezone shift. Full timestamps are shown in local time.
 */
export function formatDate(value: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  if (!value) return '—';
  // The default styles follow the signed-in user's preferred formats (Settings → General → UI);
  // other explicit options keep their Intl rendering.
  const keys = opts ? Object.keys(opts) : [];
  if (!opts || (keys.length === 1 && opts.dateStyle === 'medium')) return formatPreferredDate(value);
  if (keys.length === 2 && opts.dateStyle === 'medium' && opts.timeStyle === 'short') return formatPreferredDateTime(value);
  const d = parseDateish(value);
  if (!d) return value;
  // toLocaleDateString rejects timeStyle; toLocaleString accepts both.
  return opts.timeStyle ? d.toLocaleString(undefined, opts) : d.toLocaleDateString(undefined, opts);
}

/** Parse "YYYY-MM-DD" as local midnight, anything else with Date. */
export function parseDateish(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

export function imageUrl(images: readonly MediaImage[] | undefined, type: MediaImage['coverType']): string | undefined {
  return images?.find((i) => i.coverType === type)?.url;
}

export function seasonLabel(seasonNumber: number): string {
  return seasonNumber === 0 ? 'Specials' : `Season ${seasonNumber}`;
}
