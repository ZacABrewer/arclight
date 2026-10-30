import type { BulkSearchCommand, Movie, QualityProfile, WantedEpisode } from '@arclight/shared';
import { inArray } from 'drizzle-orm';
import { episodes, movies, series } from '../../db/schema.js';
import { libraryService, type IsCutoffMet } from '../library/index.js';
import type { SearchTarget } from '../releases/index.js';

type LibraryDb = Parameters<typeof libraryService.getMovie>[0];

/** The searches a bulk search runs, and how many selected items it covers or skipped. */
export interface BulkSearchPlan {
  targets: SearchTarget[];
  /** Items (movies, series or episodes) the targets cover. */
  queued: number;
  /** Selected items that did not match the mode. */
  skipped: number;
}

export interface PlanDeps {
  /** The cutoff check the Wanted → Cutoff unmet list uses (built once per plan). */
  isCutoffMet: () => IsCutoffMet;
  qualityProfiles: () => QualityProfile[];
  now?: string;
}

const PAGE = 500;

function allPages<T>(fetch: (page: number) => { records: T[]; totalRecords: number }): T[] {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const p = fetch(page);
    out.push(...p.records);
    if (page * PAGE >= p.totalRecords || p.records.length === 0) return out;
  }
}

/** Episodes grouped per series and season: one indexer search per group, like the scheduled jobs. */
function episodeTargets(rows: ReadonlyArray<Pick<WantedEpisode, 'id' | 'seriesId' | 'seasonNumber'>>): SearchTarget[] {
  const groups = new Map<string, { seriesId: number; ids: number[] }>();
  for (const e of rows) {
    const key = `${e.seriesId}:${e.seasonNumber}`;
    const g = groups.get(key) ?? { seriesId: e.seriesId, ids: [] };
    g.ids.push(e.id);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ seriesId: g.seriesId, episodeIds: g.ids }));
}

/**
 * Turns a bulk search command into search targets. `missing` and `upgrade` use the same lists
 * as Wanted → Missing / Cutoff unmet (so a bulk upgrade search honours each item's profile
 * cutoff, custom-format cutoff and version slots), narrowed to the selection; `upgrade` also
 * drops items whose profile does not allow upgrades. With `allMovies` / `allEpisodes`, `q` narrows
 * the list exactly as the Wanted page's search does.
 */
export function planBulkSearch(db: LibraryDb, cmd: BulkSearchCommand, deps: PlanDeps): BulkSearchPlan {
  const movieIds = [...new Set(cmd.movieIds ?? [])];
  const seriesIds = [...new Set(cmd.seriesIds ?? [])];
  const episodeIds = [...new Set(cmd.episodeIds ?? [])];
  const wantMovies = movieIds.length > 0 || cmd.allMovies === true;
  const wantEpisodes = seriesIds.length > 0 || episodeIds.length > 0 || cmd.allEpisodes === true;

  if (cmd.mode === 'all') {
    const knownMovies = movieIds.length ? new Set(db.select({ id: movies.id }).from(movies).where(inArray(movies.id, movieIds)).all().map((r) => r.id)) : new Set<number>();
    const knownSeries = seriesIds.length ? new Set(db.select({ id: series.id }).from(series).where(inArray(series.id, seriesIds)).all().map((r) => r.id)) : new Set<number>();
    const eps = episodeIds.length
      ? db.select({ id: episodes.id, seriesId: episodes.seriesId, seasonNumber: episodes.seasonNumber }).from(episodes).where(inArray(episodes.id, episodeIds)).all()
      : [];
    // An episode of a series that is searched whole is covered already.
    const looseEpisodes = eps.filter((e) => !knownSeries.has(e.seriesId));
    const targets: SearchTarget[] = [
      ...movieIds.filter((id) => knownMovies.has(id)).map((movieId) => ({ movieId })),
      ...seriesIds.filter((id) => knownSeries.has(id)).map((seriesId) => ({ seriesId })),
      ...episodeTargets(looseEpisodes),
    ];
    const queued = knownMovies.size + knownSeries.size + looseEpisodes.length;
    return { targets, queued, skipped: movieIds.length + seriesIds.length + episodeIds.length - queued };
  }

  const now = deps.now ?? new Date().toISOString();
  const isMet = cmd.mode === 'upgrade' ? deps.isCutoffMet() : null;
  const noUpgrades = cmd.mode === 'upgrade' ? new Set(deps.qualityProfiles().filter((p) => p.upgradeAllowed === false).map((p) => p.id)) : new Set<number>();

  let movieRows: Movie[] = [];
  if (wantMovies) {
    // "All" acts on the Wanted list as the page shows it, so its text search (`q`) applies too;
    // the list functions run the very same condition as GET /wanted/*/movies.
    const mq = (page: number) => ({ page, pageSize: PAGE, ...(cmd.allMovies && cmd.q ? { q: cmd.q } : {}) });
    movieRows = allPages((page) =>
      isMet ? libraryService.listCutoffUnmetMovies(db, mq(page), isMet, now) : libraryService.listMissingMovies(db, mq(page), now),
    ).filter((m) => !noUpgrades.has(m.qualityProfileId));
    if (!cmd.allMovies) {
      const picked = new Set(movieIds);
      movieRows = movieRows.filter((m) => picked.has(m.id));
    }
  }

  let episodeRows: WantedEpisode[] = [];
  let seriesWithMatches = 0;
  if (wantEpisodes) {
    const q = (page: number) => ({ page, pageSize: PAGE, includeSpecials: false, ...(cmd.allEpisodes && cmd.q ? { q: cmd.q } : {}) });
    episodeRows = allPages((page) =>
      isMet ? libraryService.listCutoffUnmetEpisodes(db, q(page), isMet) : libraryService.listMissingEpisodes(db, q(page), now),
    ).filter((e) => !noUpgrades.has(e.qualityProfileId));
    if (!cmd.allEpisodes) {
      const pickedSeries = new Set(seriesIds);
      const pickedEpisodes = new Set(episodeIds);
      episodeRows = episodeRows.filter((e) => pickedSeries.has(e.seriesId) || pickedEpisodes.has(e.id));
      const matchedSeries = new Set(episodeRows.map((e) => e.seriesId));
      seriesWithMatches = seriesIds.filter((id) => matchedSeries.has(id)).length;
    }
  }

  const targets: SearchTarget[] = [...movieRows.map((m) => ({ movieId: m.id })), ...episodeTargets(episodeRows)];
  const queued = movieRows.length + episodeRows.length;
  // Skipped: picked movies / episodes that are not on the list, and picked series with nothing on it.
  const matchedEpisodeIds = new Set(episodeRows.map((e) => e.id));
  const skipped = cmd.allMovies || cmd.allEpisodes
    ? 0
    : movieIds.length - movieRows.length + episodeIds.filter((id) => !matchedEpisodeIds.has(id)).length + (seriesIds.length - seriesWithMatches);
  return { targets, queued, skipped };
}
