import type { Episode, Series } from '@arclight/shared';
import { absoluteIndex, type SceneRule } from '../scene-mapping/mapping.js';

// Season-level searching for series: when a season is wanted enough to search for a pack, and
// the extra text queries anime batches need (fansub releases are named by season words or by
// their absolute range, which id-based season searches miss).

/**
 * Search the season as a whole (one season request that also finds packs) instead of episode
 * by episode: always for a whole season, otherwise once the wanted episodes reach `percent` of
 * the season's released episodes. A single wanted episode is always searched on its own.
 */
export function wantsSeasonSearch(wanted: number, released: number, percent: number): boolean {
  if (wanted <= 1 || released <= 0) return false;
  if (wanted >= released) return true;
  return (wanted / released) * 100 >= percent;
}

const ORDINAL_SUFFIX = (n: number): string => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
};

const MAX_ALIAS_QUERIES = 3;

/**
 * Text queries for an anime season batch: the season's scene titles (aliases mapped to it), the
 * fansub season names ("Title Season 2", "Title 2nd Season", "Title S2"), and the absolute
 * range ("Title 13-24"). Season 1 is usually released under the plain title, so it gets the
 * title + "Batch" and its absolute range. Duplicates are dropped; order is most specific first.
 */
export function animeSeasonQueries(
  series: Pick<Series, 'id' | 'title'>,
  season: number,
  episodes: readonly Episode[],
  rules: readonly SceneRule[] = [],
): string[] {
  if (season <= 0) return [];
  const title = series.title.trim();
  const out: string[] = [];
  const add = (q: string) => {
    const t = q.replace(/\s+/g, ' ').trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };

  const aliases = rules
    .filter((r) => r.seriesId === series.id && r.kind === 'title' && r.sceneTitle && (r.tvdbSeason === season || r.sceneSeason === season))
    .map((r) => r.sceneTitle!)
    .slice(0, MAX_ALIAS_QUERIES);
  for (const a of aliases) add(a);

  if (season > 1) {
    add(`${title} Season ${season}`);
    add(`${title} ${ORDINAL_SUFFIX(season)} Season`);
    add(`${title} S${season}`);
  } else {
    add(`${title} Batch`);
  }

  const range = absoluteRange(episodes, season);
  if (range) {
    const width = Math.max(2, String(range[1]).length);
    add(`${title} ${String(range[0]).padStart(width, '0')}-${String(range[1]).padStart(width, '0')}`);
  }
  return out;
}

/** First and last absolute number of a season (library numbers, else derived in order). */
export function absoluteRange(episodes: readonly Episode[], season: number): [number, number] | null {
  const index = absoluteIndex(episodes, true);
  const nums = [...index.entries()].filter(([, e]) => e.seasonNumber === season).map(([abs]) => abs);
  if (nums.length < 2) return null;
  return [Math.min(...nums), Math.max(...nums)];
}
