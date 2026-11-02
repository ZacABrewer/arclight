import type { PlaybackBucket, PlaybackDay, PlayMethodCounts } from '@arclight/shared';
import { formatDecimal, intlLocale, t } from '../../i18n/index.js';

// Pure helpers for the playback stats and Year in review views: watch time in words, shares
// for the meter rows, the per-day series, heatmap scaling and weekday / month names.

export const PERIODS = [7, 30, 90, 365] as const;
export type Period = (typeof PERIODS)[number];

/** Watch time as hours with one decimal ("12.5 h"); minutes under an hour ("42 min"). */
export function watchTime(ms: number): string {
  if (ms < 3_600_000) return t('watchStats.minutesShort', { value: Math.round(ms / 60_000) });
  return t('watchStats.hoursShort', { value: formatDecimal(ms / 3_600_000, 1) });
}

/** Whole hours for the big tiles. */
export function hours(ms: number): string {
  return formatDecimal(ms / 3_600_000, ms < 36_000_000 ? 1 : 0);
}

export interface ShareRow {
  key: string;
  label: string;
  value: number;
  /** 0-100 share of the total. */
  pct: number;
}

/** Direct play / direct stream / transcode (and plays without session details) as shares. */
export function playMethodRows(m: PlayMethodCounts): ShareRow[] {
  const rows = [
    { key: 'directPlay', label: t('watchStats.directPlay'), value: m.directPlay },
    { key: 'directStream', label: t('watchStats.directStream'), value: m.directStream },
    { key: 'transcode', label: t('watchStats.transcode'), value: m.transcode },
    { key: 'unknown', label: t('watchStats.unknownMethod'), value: m.unknown },
  ];
  const total = rows.reduce((n, r) => n + r.value, 0);
  return rows.filter((r) => r.key !== 'unknown' || r.value > 0).map((r) => ({ ...r, pct: total > 0 ? (r.value / total) * 100 : 0 }));
}

/** Buckets (genres, clients, devices) as shares of the largest play count, at most `limit`. */
export function bucketRows(buckets: readonly PlaybackBucket[], limit = 8): ShareRow[] {
  const top = [...buckets].sort((a, b) => b.plays - a.plays || b.watchMs - a.watchMs).slice(0, limit);
  const total = buckets.reduce((n, b) => n + b.plays, 0);
  return top.map((b) => ({ key: b.name, label: b.name || t('watchStats.unknown'), value: b.plays, pct: total > 0 ? (b.plays / total) * 100 : 0 }));
}

const DAY = 86_400_000;

/** One entry per day from `from` to `to` (inclusive); days the api left out count as zero. */
export function fillPlayDays(perDay: readonly PlaybackDay[], from: string, to: string): PlaybackDay[] {
  const byDate = new Map(perDay.map((d) => [d.date.slice(0, 10), d]));
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [...perDay];
  const out: PlaybackDay[] = [];
  for (let ms = start; ms <= end && out.length < 3700; ms += DAY) {
    const date = new Date(ms).toISOString().slice(0, 10);
    out.push(byDate.get(date) ?? { date, plays: 0, watchMs: 0 });
  }
  return out;
}

/** Largest cell of the 7x24 heatmap (at least 1, so empty grids still draw). */
export function heatmapMax(grid: readonly (readonly number[])[]): number {
  return Math.max(1, ...grid.flat());
}

/** Weekday name (0 = Sunday) in the UI language. */
export function weekdayName(day: number, style: 'long' | 'short' = 'long'): string {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(intlLocale(), { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + day)));
}

/** Month name (1-12) in the UI language. */
export function monthName(month: number, style: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(intlLocale(), { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, month - 1, 1)));
}

/** "21:00". */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** "2026-03" -> short month and year in the UI language. */
export function monthKeyLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return new Intl.DateTimeFormat(intlLocale(), { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** A date-only ISO string in the UI language ("Mar 14, 2026"). */
export function dayLabel(iso: string): string {
  const ms = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) return iso;
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(ms));
}

/** The link a share opens: the absolute url when the api knows the public address, else this origin + path. */
export function shareLink(share: { url: string | null; path: string }, origin = typeof window === 'undefined' ? '' : window.location.origin): string {
  return share.url ?? `${origin}${share.path}`;
}
