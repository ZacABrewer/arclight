import type { Episode } from '@arclight/shared';
import type { ChipTone } from '../../arclight/index.js';

/**
 * - downloaded: has a file
 * - wanted: aired, monitored (episode and series), no file — what a search would look for
 * - missing: aired, no file, but not monitored
 * - unaired: has an air date in the future
 * - tba: no air date yet
 */
export type EpisodeStatus = 'downloaded' | 'wanted' | 'missing' | 'unaired' | 'tba';

type EpisodeLike = Pick<Episode, 'hasFile' | 'monitored' | 'airDate' | 'airDateUtc'>;

/** True once the episode has aired. Prefers the UTC instant; falls back to the date string. */
export function hasAired(ep: Pick<Episode, 'airDate' | 'airDateUtc'>, now: Date = new Date()): boolean | null {
  if (ep.airDateUtc) {
    const t = Date.parse(ep.airDateUtc);
    if (!Number.isNaN(t)) return t <= now.getTime();
  }
  if (ep.airDate) return ep.airDate <= localIsoDate(now);
  return null;
}

export function episodeStatus(ep: EpisodeLike, opts: { seriesMonitored?: boolean; now?: Date } = {}): EpisodeStatus {
  if (ep.hasFile) return 'downloaded';
  const aired = hasAired(ep, opts.now);
  if (aired === null) return 'tba';
  if (!aired) return 'unaired';
  return ep.monitored && (opts.seriesMonitored ?? true) ? 'wanted' : 'missing';
}

export const EPISODE_STATUS_META: Record<EpisodeStatus, { label: string; tone: ChipTone }> = {
  downloaded: { label: 'Downloaded', tone: 'accent' },
  wanted: { label: 'Wanted', tone: 'danger' },
  missing: { label: 'Missing', tone: 'warn' },
  unaired: { label: 'Unaired', tone: 'default' },
  tba: { label: 'TBA', tone: 'neutral' },
};

/** YYYY-MM-DD in local time. */
export function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Counts per status, for season headers. */
export function countStatuses(eps: readonly EpisodeLike[], opts: { seriesMonitored?: boolean; now?: Date } = {}) {
  const out: Record<EpisodeStatus, number> = { downloaded: 0, wanted: 0, missing: 0, unaired: 0, tba: 0 };
  for (const ep of eps) out[episodeStatus(ep, opts)] += 1;
  return out;
}
