import type { CalendarItem } from '@arclight/shared';
import { episodeStatus, localIsoDate, type EpisodeStatus } from '../../components/media/episode-status.js';
import { episodeCode, parseDateish } from '../../components/media/format.js';

// Pure calendar math: month grids, request ranges, grouping items by local day.

/** 0 = Sunday, 1 = Monday. */
export type WeekStart = 0 | 1;

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Every day shown in a month view: whole weeks from the week containing the 1st to the week containing the last day. */
export function monthGrid(anchor: Date, weekStart: WeekStart = 1): Date[] {
  const first = startOfMonth(anchor);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const trail = (weekStart + 6 - last.getDay() + 7) % 7;
  const start = addDays(first, -lead);
  const total = lead + last.getDate() + trail;
  return Array.from({ length: total }, (_, i) => addDays(start, i));
}

/** Weekday header labels in grid order. */
export function weekdayLabels(weekStart: WeekStart = 1, locale?: string): string[] {
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2023, 0, 1 + ((i + weekStart) % 7)).toLocaleDateString(locale, { weekday: 'short' }),
  );
}

/** The api range covering a grid: first day 00:00 local to the last day 23:59:59.999 local, as ISO. */
export function gridRange(days: readonly Date[]): { start: string; end: string } {
  const first = days[0] ?? new Date();
  const last = days[days.length - 1] ?? first;
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59, 999);
  return { start: first.toISOString(), end: end.toISOString() };
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** A calendar item flattened for display. */
export interface CalendarEntry {
  key: string;
  /** Local YYYY-MM-DD the entry lands on. */
  day: string;
  /** Sort key within a day; date-only items sort first. */
  sortTime: number;
  /** Local time label when the item has a time component. */
  time: string | null;
  kind: 'episode' | 'movie';
  title: string;
  detail: string;
  status: EpisodeStatus;
  monitored: boolean;
  link: { to: '/library/series/$id' | '/library/movie/$id'; params: { id: string } };
}

const RELEASE_LABELS = { cinema: 'In cinemas', digital: 'Digital release', physical: 'Physical release' } as const;

export function toEntry(item: CalendarItem, now: Date = new Date()): CalendarEntry | null {
  const parsed = parseDateish(item.date);
  if (!parsed) return null;
  const hasTime = !/^\d{4}-\d{2}-\d{2}$/.test(item.date);
  const day = localIsoDate(parsed);
  const time = hasTime ? parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null;
  const sortTime = hasTime ? parsed.getTime() : parsed.getTime() - 1;
  if (item.type === 'episode') {
    const ep = item.episode;
    const seriesMonitored = item.series?.monitored ?? true;
    return {
      key: `e${ep.id}`,
      day,
      sortTime,
      time,
      kind: 'episode',
      title: item.seriesTitle,
      detail: `${episodeCode(ep.seasonNumber, ep.episodeNumber)}${ep.title ? ` · ${ep.title}` : ''}`,
      status: episodeStatus(ep, { seriesMonitored, now }),
      monitored: ep.monitored && seriesMonitored,
      link: { to: '/library/series/$id', params: { id: String(item.seriesId) } },
    };
  }
  const m = item.movie;
  const released = parsed.getTime() <= now.getTime();
  return {
    key: `m${m.id}-${item.releaseKind}`,
    day,
    sortTime,
    time,
    kind: 'movie',
    title: m.title,
    detail: RELEASE_LABELS[item.releaseKind],
    status: m.hasFile ? 'downloaded' : !released ? 'unaired' : m.monitored ? 'wanted' : 'missing',
    monitored: m.monitored,
    link: { to: '/library/movie/$id', params: { id: String(m.id) } },
  };
}

/** Group entries by local day, each day sorted by time then title. */
export function groupByDay(items: readonly CalendarItem[], now: Date = new Date()): Map<string, CalendarEntry[]> {
  const out = new Map<string, CalendarEntry[]>();
  for (const item of items) {
    const e = toEntry(item, now);
    if (!e) continue;
    const list = out.get(e.day) ?? [];
    list.push(e);
    out.set(e.day, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.sortTime - b.sortTime || a.title.localeCompare(b.title));
  return out;
}
