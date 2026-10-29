import type { CalendarItem } from '@arclight/shared';
import { episodeStatus, localIsoDate, type EpisodeStatus } from '../../components/media/episode-status.js';
import { episodeCode, imageUrl, parseDateish } from '../../components/media/format.js';
import { clockLabel, type TimeFormat } from '../../lib/ui-preferences.js';
import { albumCover, albumState, albumTypeLabel, artistImage } from '../library/music/music-model.js';
import { authorImage, bookCover, bookState, positionLabel, primarySeries } from '../library/audiobooks/audiobook-model.js';
import { t, intlLocale } from '../../i18n/index.js';

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
export function weekdayLabels(weekStart: WeekStart = 1, locale: string | undefined = intlLocale()): string[] {
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

/** Monday (or Sunday) starting the week that contains `d`. */
export function startOfWeek(d: Date, weekStart: WeekStart = 1): Date {
  return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() - weekStart + 7) % 7));
}

/** The 7 days of the week containing `anchor`. */
export function weekDays(anchor: Date, weekStart: WeekStart = 1): Date[] {
  const start = startOfWeek(anchor, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export type CalendarView = 'month' | 'week' | 'day' | 'agenda';

/** Days a view shows around its anchor. */
export function viewDays(view: CalendarView, anchor: Date, weekStart: WeekStart = 1): Date[] {
  if (view === 'week') return weekDays(anchor, weekStart);
  if (view === 'day') return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
  return monthGrid(anchor, weekStart);
}

/** Move the anchor one view-length back/forward. */
export function stepAnchor(view: CalendarView, anchor: Date, dir: 1 | -1): Date {
  if (view === 'week') return addDays(anchor, 7 * dir);
  if (view === 'day') return addDays(anchor, dir);
  return addMonths(anchor, dir);
}

/** Event bar tone (Page 05): cyan solid = downloaded, cyan 40% = upcoming, orange = missing. */
export type BarTone = 'downloaded' | 'upcoming' | 'missing';

export function barTone(status: EpisodeStatus): BarTone {
  if (status === 'downloaded') return 'downloaded';
  if (status === 'unaired' || status === 'tba') return 'upcoming';
  return 'missing';
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
  kind: 'episode' | 'movie' | 'album' | 'book';
  title: string;
  detail: string;
  status: EpisodeStatus;
  tone: BarTone;
  monitored: boolean;
  /** Local hour as a fraction (21.5 = 21:30); null for date-only items. */
  hour: number | null;
  /** "S02E03" for episodes, the release label for movies, the album type for albums, the series position for books. */
  code: string;
  /** Episode title (episodes), album title (albums). */
  subtitle: string | null;
  posterUrl: string | undefined;
  /** Automatic search body (POST /command/search) for videos; null for albums and books (AlbumSearch / BookSearch). */
  search: { episodeIds: number[] } | { movieId: number } | null;
  link: { to: '/library/series/$id' | '/library/movie/$id' | '/library/music/album/$id' | '/library/audiobooks/book/$id'; params: { id: string } };
}

const RELEASE_LABELS = { get cinema() { return t('common.inCinemas'); }, get digital() { return t('calendar.math.digitalRelease'); }, get physical() { return t('calendar.math.physicalRelease'); } } as const;

export function toEntry(item: CalendarItem, now: Date = new Date(), timeFormat: TimeFormat = '24h'): CalendarEntry | null {
  const parsed = parseDateish(item.date);
  if (!parsed) return null;
  const hasTime = !/^\d{4}-\d{2}-\d{2}$/.test(item.date);
  const day = localIsoDate(parsed);
  // Mono times; 24h by default, as the kit draws them (21:00, 03:00).
  const time = hasTime ? clockLabel(parsed.getHours(), parsed.getMinutes(), timeFormat) : null;
  const sortTime = hasTime ? parsed.getTime() : parsed.getTime() - 1;
  const hour = hasTime ? parsed.getHours() + parsed.getMinutes() / 60 : null;
  if (item.type === 'episode') {
    const ep = item.episode;
    const seriesMonitored = item.series?.monitored ?? true;
    const status = episodeStatus(ep, { seriesMonitored, now });
    const code = episodeCode(ep.seasonNumber, ep.episodeNumber);
    return {
      key: `e${ep.id}`,
      day,
      sortTime,
      time,
      kind: 'episode',
      title: item.seriesTitle,
      detail: `${code}${ep.title ? ` · ${ep.title}` : ''}`,
      status,
      tone: barTone(status),
      monitored: ep.monitored && seriesMonitored,
      hour,
      code,
      subtitle: ep.title || null,
      posterUrl: imageUrl(item.series?.images, 'poster'),
      search: { episodeIds: [ep.id] },
      link: { to: '/library/series/$id', params: { id: String(item.seriesId) } },
    };
  }
  if (item.type === 'album') {
    const album = item.album;
    const status: EpisodeStatus = albumState(album, now);
    const monitored = album.monitored && item.artist.monitored;
    return {
      key: `a${album.id}`,
      day,
      sortTime,
      time,
      kind: 'album',
      title: item.artistName,
      detail: album.title,
      status,
      tone: barTone(status),
      monitored,
      hour,
      code: albumTypeLabel(album.primaryType),
      subtitle: album.title,
      posterUrl: albumCover(album) ?? artistImage(item.artist),
      search: null,
      link: { to: '/library/music/album/$id', params: { id: String(album.id) } },
    };
  }
  if (item.type === 'book') {
    const book = item.book;
    const status: EpisodeStatus = bookState(book, now);
    const series = primarySeries(book);
    const position = series ? positionLabel(series.position) : null;
    return {
      key: `b${book.id}`,
      day,
      sortTime,
      time,
      kind: 'book',
      title: item.authorName,
      detail: book.title,
      status,
      tone: barTone(status),
      monitored: book.monitored && item.author.monitored,
      hour,
      code: position ? `${series!.name} · ${position}` : (series?.name ?? t('audiobooks.audiobook')),
      subtitle: book.title,
      posterUrl: bookCover(book) ?? authorImage(item.author),
      search: null,
      link: { to: '/library/audiobooks/book/$id', params: { id: String(book.id) } },
    };
  }
  const m = item.movie;
  const released = parsed.getTime() <= now.getTime();
  const status: EpisodeStatus = m.hasFile ? 'downloaded' : !released ? 'unaired' : m.monitored ? 'wanted' : 'missing';
  return {
    key: `m${m.id}-${item.releaseKind}`,
    day,
    sortTime,
    time,
    kind: 'movie',
    title: m.title,
    detail: RELEASE_LABELS[item.releaseKind],
    status,
    tone: barTone(status),
    monitored: m.monitored,
    hour,
    code: RELEASE_LABELS[item.releaseKind],
    subtitle: null,
    posterUrl: imageUrl(m.images, 'poster'),
    search: { movieId: m.id },
    link: { to: '/library/movie/$id', params: { id: String(m.id) } },
  };
}

/** Group entries by local day, each day sorted by time then title. */
export function groupByDay(items: readonly CalendarItem[], now: Date = new Date(), timeFormat: TimeFormat = '24h'): Map<string, CalendarEntry[]> {
  const out = new Map<string, CalendarEntry[]>();
  for (const item of items) {
    const e = toEntry(item, now, timeFormat);
    if (!e) continue;
    const list = out.get(e.day) ?? [];
    list.push(e);
    out.set(e.day, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.sortTime - b.sortTime || a.title.localeCompare(b.title));
  return out;
}
