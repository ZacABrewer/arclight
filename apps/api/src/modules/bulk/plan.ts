import { isEpisodeReleased, isMovieReleased, type BulkSearchCommand, type Movie, type QualityProfile, type WantedEpisode } from '@arclight/shared';
import { inArray } from 'drizzle-orm';
import { episodes, movies, series } from '../../db/schema.js';
import { libraryService, type IsCutoffMet } from '../library/index.js';
import type { ReleaseGate, SearchTarget } from '../releases/index.js';

type LibraryDb = Parameters<typeof libraryService.getMovie>[0];

/** The searches a bulk search runs, and how many selected items it covers or skipped. */
export interface BulkSearchPlan {
  targets: SearchTarget[];
  /** Items (movies, series or episodes) the targets cover. */
  queued: number;
  /** Selected items that did not match the mode, or are not released yet. */
  skipped: number;
  /** How many of `skipped` are not released yet (never searched, release-dates.ts). */
  unreleased: number;
}

export interface PlanDeps {
  /** The cutoff check the Wanted → Cutoff unmet list uses (built once per plan). */
  isCutoffMet: () => IsCutoffMet;
  qualityProfiles: () => QualityProfile[];
  now?: string;
  /**
   * The release check of user-started searches (ReleasesService.releaseGate(true)); null =
   * `searchUnreleased` is on. Omitted = released as of `now`.
   */
  releaseGate?: ReleaseGate | null;
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
  const now = deps.now ?? new Date().toISOString();
  const gate = deps.releaseGate === undefined ? { nowMs: Date.parse(now), graceHours: 0 } : deps.releaseGate;
  // Never search what is not out yet: such movies / episodes are skipped (and counted).
  const movieOut = (m: Parameters<typeof isMovieReleased>[0]) => !gate || isMovieReleased(m, gate.nowMs, gate.graceHours);
  const episodeOut = (e: Parameters<typeof isEpisodeReleased>[0]) => !gate || isEpisodeReleased(e, gate.nowMs, gate.graceHours);

  if (cmd.mode === 'all') {
    const movieRows = movieIds.length ? db.select().from(movies).where(inArray(movies.id, movieIds)).all() : [];
    const outMovies = new Set(movieRows.filter(movieOut).map((r) => r.id));
    const knownSeries = seriesIds.length ? new Set(db.select({ id: series.id }).from(series).where(inArray(series.id, seriesIds)).all().map((r) => r.id)) : new Set<number>();
    const eps = episodeIds.length
      ? db
          .select({ id: episodes.id, seriesId: episodes.seriesId, seasonNumber: episodes.seasonNumber, airDate: episodes.airDate, airDateUtc: episodes.airDateUtc })
          .from(episodes)
          .where(inArray(episodes.id, episodeIds))
          .all()
      : [];
    // An episode of a series that is searched whole is covered already. (A whole-series search
    // leaves out its unaired episodes itself.)
    const looseEpisodes = eps.filter((e) => !knownSeries.has(e.seriesId));
    const outEpisodes = looseEpisodes.filter(episodeOut);
    const targets: SearchTarget[] = [
      ...movieIds.filter((id) => outMovies.has(id)).map((movieId) => ({ movieId })),
      ...seriesIds.filter((id) => knownSeries.has(id)).map((seriesId) => ({ seriesId })),
      ...episodeTargets(outEpisodes),
    ];
    const queued = outMovies.size + knownSeries.size + outEpisodes.length;
    const unreleased = movieRows.length - outMovies.size + looseEpisodes.length - outEpisodes.length;
    return { targets, queued, skipped: movieIds.length + seriesIds.length + episodeIds.length - queued, unreleased };
  }

  const isMet = cmd.mode === 'upgrade' ? deps.isCutoffMet() : null;
  const noUpgrades = cmd.mode === 'upgrade' ? new Set(deps.qualityProfiles().filter((p) => p.upgradeAllowed === false).map((p) => p.id)) : new Set<number>();

  // "All" acts on the Wanted list as the page shows it, so its text search (`q`) and release
  // filter apply too. Picked ids are looked up on the whole list (released or not), so a picked
  // item that is not out yet is skipped for that reason and counted as such.
  const filterOf = (all: boolean | undefined) =>
    all
      ? {
          ...(cmd.q ? { q: cmd.q } : {}),
          ...(cmd.released ? { released: cmd.released } : {}),
          ...(cmd.releasedAfter ? { releasedAfter: cmd.releasedAfter } : {}),
          ...(cmd.releasedBefore ? { releasedBefore: cmd.releasedBefore } : {}),
        }
      : { released: 'all' as const };

  let movieRows: Movie[] = [];
  let unreleasedMovies = 0;
  if (wantMovies) {
    // The list functions run the very same conditions as GET /wanted/*/movies.
    const mq = (page: number) => ({ page, pageSize: PAGE, ...filterOf(cmd.allMovies) });
    movieRows = allPages((page) =>
      isMet ? libraryService.listCutoffUnmetMovies(db, mq(page), isMet, now) : libraryService.listMissingMovies(db, mq(page), now),
    ).filter((m) => !noUpgrades.has(m.qualityProfileId));
    if (!cmd.allMovies) {
      const picked = new Set(movieIds);
      movieRows = movieRows.filter((m) => picked.has(m.id));
    }
    const out = movieRows.filter(movieOut);
    unreleasedMovies = movieRows.length - out.length;
    movieRows = out;
  }

  let episodeRows: WantedEpisode[] = [];
  let unreleasedEpisodes = 0;
  let seriesWithMatches = 0;
  if (wantEpisodes) {
    const q = (page: number) => ({ page, pageSize: PAGE, includeSpecials: false, ...filterOf(cmd.allEpisodes) });
    episodeRows = allPages((page) =>
      isMet ? libraryService.listCutoffUnmetEpisodes(db, q(page), isMet, now) : libraryService.listMissingEpisodes(db, q(page), now),
    ).filter((e) => !noUpgrades.has(e.qualityProfileId));
    if (!cmd.allEpisodes) {
      const pickedSeries = new Set(seriesIds);
      const pickedEpisodes = new Set(episodeIds);
      episodeRows = episodeRows.filter((e) => pickedSeries.has(e.seriesId) || pickedEpisodes.has(e.id));
    }
    // A picked series' unaired episodes are not picked items of their own: only those picked
    // one by one (or taken by "all") count as skipped.
    unreleasedEpisodes = episodeRows.filter((e) => !episodeOut(e) && (cmd.allEpisodes || episodeIds.includes(e.id))).length;
    episodeRows = episodeRows.filter(episodeOut);
    if (!cmd.allEpisodes) {
      const matchedSeries = new Set(episodeRows.map((e) => e.seriesId));
      seriesWithMatches = seriesIds.filter((id) => matchedSeries.has(id)).length;
    }
  }

  const targets: SearchTarget[] = [...movieRows.map((m) => ({ movieId: m.id })), ...episodeTargets(episodeRows)];
  const queued = movieRows.length + episodeRows.length;
  const unreleased = unreleasedMovies + unreleasedEpisodes;
  // Skipped: picked movies / episodes that are not on the list or not out yet, and picked series
  // with nothing released on it. With "all", the list's rows that are not out yet.
  const matchedEpisodeIds = new Set(episodeRows.map((e) => e.id));
  const skipped = cmd.allMovies || cmd.allEpisodes
    ? unreleased
    : movieIds.length - movieRows.length + episodeIds.filter((id) => !matchedEpisodeIds.has(id)).length + (seriesIds.length - seriesWithMatches);
  return { targets, queued, skipped, unreleased };
}
