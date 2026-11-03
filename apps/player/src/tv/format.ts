import type { FeaturedKicker, MediaChips, VideoProgress } from '@arclight/shared';
import { chipLabels } from '../kit/chips';

// Text the TV screens show, as the design writes it (template `left`, `playLabel`, `metaFor`,
// kickers), with the words translated.

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** "1h 52m" / "45m" from seconds (at least 1m). */
export function left(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** "27m left", or null without a place to resume from. */
export function leftLabel(p: VideoProgress | null | undefined, t: Translate): string | null {
  if (!p || p.played || p.positionMs <= 0 || p.durationMs <= 0) return null;
  return t('app.tv.left', { time: left((p.durationMs - p.positionMs) / 1000) });
}

/** 0..1, or null when nothing to show. */
export function fraction(p: VideoProgress | null | undefined): number | null {
  if (!p || p.durationMs <= 0) return null;
  if (p.played) return 1;
  if (p.positionMs <= 0) return null;
  return Math.min(1, p.positionMs / p.durationMs);
}

export const pct = (f: number | null | undefined) => `${Math.round(Math.max(0, Math.min(1, f ?? 0)) * 1000) / 10}%`;

/** Play / Resume / Play S1 E1 / Resume S2 E5. */
export function playLabel(
  kind: 'movie' | 'series',
  play: { seasonNumber: number | null; episodeNumber: number | null; progress: VideoProgress | null } | null,
  t: Translate,
): string {
  const resuming = Boolean(play?.progress && !play.progress.played && play.progress.positionMs > 0);
  if (kind === 'series' && play && play.seasonNumber != null && play.episodeNumber != null) {
    return t(resuming ? 'app.tv.resumeEpisode' : 'app.tv.playEpisode', { s: play.seasonNumber, e: play.episodeNumber });
  }
  return t(resuming ? 'app.tv.resume' : 'app.tv.play');
}

const KICKER_KEYS: Record<FeaturedKicker, string> = {
  'new-episode': 'app.tv.kicker.newEpisode',
  'just-added': 'app.tv.kicker.justAdded',
  continue: 'app.tv.kicker.continue',
  'my-list': 'app.tv.kicker.myList',
  trending: 'app.tv.kicker.trending',
  'top-rated': 'app.tv.kicker.topRated',
};

/** A weekday name in the UI language (0 = Sunday). */
export function weekdayName(day: number, locale?: string): string {
  // 2023-01-01 was a Sunday.
  const d = new Date(Date.UTC(2023, 0, 1 + day, 12));
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' }).format(d);
  }
}

export function kickerLabel(kicker: FeaturedKicker, weekday: number | null, t: Translate, locale?: string): string {
  if (kicker === 'new-episode' && weekday != null) return t('app.tv.kicker.newEpisodeEvery', { weekday: weekdayName(weekday, locale) });
  return t(KICKER_KEYS[kicker]);
}

export interface MetaItem {
  text: string;
  kind: 'plain' | 'boxed' | 'chip';
}

/** year · [cert] · runtime or "N Seasons" · genres · chips (template metaFor). */
export function metaItems(
  m: { year: number | null; certification: string | null; runtimeMinutes?: number | null; seasonCount?: number | null; genres: readonly string[]; chips?: MediaChips | null },
  t: Translate,
): MetaItem[] {
  const out: MetaItem[] = [];
  if (m.year) out.push({ text: String(m.year), kind: 'plain' });
  if (m.certification) out.push({ text: m.certification, kind: 'boxed' });
  if (m.seasonCount) out.push({ text: t('app.tv.seasons', { n: m.seasonCount }), kind: 'plain' });
  else if (m.runtimeMinutes) out.push({ text: left(m.runtimeMinutes * 60), kind: 'plain' });
  if (m.genres.length) out.push({ text: m.genres.join(', '), kind: 'plain' });
  for (const c of chipLabels(m.chips ?? null, t)) out.push({ text: c, kind: 'chip' });
  return out;
}

/** "m:ss" / "h:mm:ss" (template fmt). */
export function clock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/** The design's search typing: no leading spaces, at most 32 characters. */
export function typeInto(query: string, c: string): string {
  return (query + c).replace(/^\s+/, '').slice(0, 32);
}
