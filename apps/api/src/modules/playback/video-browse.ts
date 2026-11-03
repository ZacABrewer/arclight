import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  itemKey,
  rankMatches,
  RESUME_MIN,
  type ContentRestrictions,
  type PlaybackProgress,
  type PlayerEpisode,
  type PlayerMovie,
  type PlayerMovieDetails,
  type PlayerMoviePage,
  type PlayerSeason,
  type PlayerSeries,
  type PlayerSeriesDetails,
  type PlayerSeriesPage,
  type VideoBrowseQuery,
  type VideoCard,
  type VideoHome,
  type VideoProgress,
  type VideoWatchedRequest,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, movies, series } from '../library/schema.js';
import { restrictionsOfSettings } from '../requests/certification.js';
import type { BrowseUser } from './browse.js';
import type { ProgressStore } from './progress.js';
import { badgesOf, dynamicRangeOf, resolutionLabel, versionDescription } from './video-info.js';
import {
  episodeCode,
  imageUrl,
  movieFiles,
  playableEpisodes,
  ratingOf,
  seasonOrder,
  versionsOf,
  toVersion,
  videoArtworkUrl,
  withinRestrictions,
  type EpisodeRow,
  type MovieRow,
  type SeriesRow,
} from './video-items.js';

// Movies & TV browse for the player: home rows, movie and series pages and details, search and
// "mark watched". Only items with files, only within the user's content restrictions. Progress
// is the effective progress (Arclight's own merged with a linked media-server account).

export interface VideoBrowseContext {
  db: Db;
  basePath: string;
  progress: ProgressStore;
  now?: () => number;
}

/** Next up looks at series with an episode played this recently. */
export const NEXT_UP_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
export const HOME_ROW = 20;
const CHUNK = 500;

export function restrictionsOf(user: BrowseUser): ContentRestrictions | null {
  return user.userId === null ? null : restrictionsOfSettings(user.settings);
}

/** Effective progress for many keys (chunked: SQLite caps bound parameters). */
export function progressFor(ctx: VideoBrowseContext, user: BrowseUser, keys: readonly string[]): Map<string, PlaybackProgress> {
  const out = new Map<string, PlaybackProgress>();
  if (user.userId === null) return out;
  for (let i = 0; i < keys.length; i += CHUNK) {
    for (const [k, v] of ctx.progress.effective(user.userId, user.settings, keys.slice(i, i + CHUNK))) out.set(k, v);
  }
  return out;
}

export const toVideoProgress = (p: PlaybackProgress | undefined): VideoProgress | null =>
  p && (p.played || p.positionMs > 0) ? { positionMs: p.positionMs, durationMs: p.durationMs, played: p.played } : null;

export const inProgress = (p: PlaybackProgress | undefined) => !!p && !p.played && p.durationMs > 0 && p.positionMs >= p.durationMs * RESUME_MIN;

/** "#" for titles that do not start with a letter. */
const letterOf = (title: string) => {
  const c = title.trim().charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
};

function paginate<T>(list: readonly T[], q: VideoBrowseQuery): { items: T[]; total: number; page: number; pageSize: number } {
  const start = (q.page - 1) * q.pageSize;
  return { items: list.slice(start, start + q.pageSize), total: list.length, page: q.page, pageSize: q.pageSize };
}

// ---- movies ------------------------------------------------------------------------------------

export interface MovieFacts {
  row: MovieRow;
  addedAt: string | null;
  badges: string[];
}

/** Movies with files within the caps, with their newest file date and the best file's badges. */
export function playableMovies(ctx: VideoBrowseContext, user: BrowseUser): MovieFacts[] {
  const r = restrictionsOf(user);
  const rows = ctx.db.select().from(movies).where(eq(movies.hasFile, true)).all().filter((m) => withinRestrictions(r, 'movie', m.certification));
  const files = ctx.db
    .select({ movieId: mediaFiles.movieId, dateAdded: mediaFiles.dateAdded, mediaInfo: mediaFiles.mediaInfo })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.mediaType, 'movie'), isNotNull(mediaFiles.movieId)))
    .all();
  const byMovie = new Map<number, typeof files>();
  for (const f of files) {
    const list = byMovie.get(f.movieId!) ?? [];
    list.push(f);
    byMovie.set(f.movieId!, list);
  }
  return rows.flatMap((row) => {
    const list = byMovie.get(row.id);
    if (!list || list.length === 0) return [];
    const addedAt = list.map((f) => f.dateAdded).sort().at(-1) ?? null;
    const badges = new Set<string>();
    for (const f of list) for (const b of badgesOf({ width: f.mediaInfo?.width ?? null, height: f.mediaInfo?.height ?? null, dynamicRange: dynamicRangeOf(f.mediaInfo ?? null) })) badges.add(b);
    return [{ row, addedAt, badges: ['4K', 'HDR', 'DV'].filter((b) => badges.has(b)) }];
  });
}

function toPlayerMovie(ctx: VideoBrowseContext, m: MovieFacts, progress: PlaybackProgress | undefined): PlayerMovie {
  const { row } = m;
  return {
    id: row.id,
    itemKey: itemKey('movie', row.id),
    title: row.title,
    year: row.year || null,
    posterUrl: imageUrl(ctx.basePath, 'movie', row.id, row.images, 'poster', '342'),
    backdropUrl: imageUrl(ctx.basePath, 'movie', row.id, row.images, 'fanart', '1280'),
    runtimeMinutes: row.runtimeMinutes,
    certification: row.certification,
    rating: ratingOf(row.ratings),
    genres: row.genres,
    addedAt: m.addedAt,
    progress: toVideoProgress(progress),
    played: progress?.played ?? false,
    badges: m.badges,
  };
}

type Sortable = { title: string; sortTitle: string; addedAt: string | null; year: number | null; rating: number | null };

function sortList<T>(list: T[], q: VideoBrowseQuery, key: (t: T) => Sortable): T[] {
  const sign = q.order === 'desc' ? -1 : 1;
  const cmp = (a: T, b: T): number => {
    const x = key(a);
    const y = key(b);
    let c = 0;
    if (q.sort === 'added') c = (x.addedAt ?? '').localeCompare(y.addedAt ?? '');
    else if (q.sort === 'year') c = (x.year ?? 0) - (y.year ?? 0);
    else if (q.sort === 'rating') c = (x.rating ?? 0) - (y.rating ?? 0);
    return sign * c || x.sortTitle.localeCompare(y.sortTitle, undefined, { numeric: true, sensitivity: 'base' });
  };
  return list.sort(cmp);
}

/** Search narrows and orders by relevance; genre and letter narrow. */
function filterList<T>(list: T[], q: VideoBrowseQuery, title: (t: T) => string, sortTitle: (t: T) => string, genres: (t: T) => readonly string[], keywords?: (t: T) => string[]): { list: T[]; ranked: boolean } {
  let out = list;
  if (q.genre) {
    const g = q.genre.toLowerCase();
    out = out.filter((t) => genres(t).some((x) => x.toLowerCase() === g));
  }
  if (q.letter) {
    const l = q.letter.toUpperCase();
    out = out.filter((t) => letterOf(sortTitle(t)) === (l >= 'A' && l <= 'Z' ? l : '#'));
  }
  if (q.search?.trim()) return { list: rankMatches(q.search, out, title, keywords).map((m) => m.item), ranked: true };
  return { list: out, ranked: false };
}

export function moviePage(ctx: VideoBrowseContext, user: BrowseUser, q: VideoBrowseQuery): PlayerMoviePage {
  const all = playableMovies(ctx, user);
  const { list, ranked } = filterList(
    all,
    q,
    (m) => m.row.title,
    (m) => m.row.sortTitle || m.row.title,
    (m) => m.row.genres,
    (m) => [m.row.originalTitle],
  );
  const progress = progressFor(
    ctx,
    user,
    list.map((m) => itemKey('movie', m.row.id)),
  );
  let items = list.map((m) => toPlayerMovie(ctx, m, progress.get(itemKey('movie', m.row.id))));
  if (q.watched !== 'all') items = items.filter((m) => m.played === (q.watched === 'watched'));
  if (!ranked) {
    const sortTitles = new Map(list.map((m) => [m.row.id, m.row.sortTitle || m.row.title]));
    items = sortList(items, q, (m) => ({ title: m.title, sortTitle: sortTitles.get(m.id) ?? m.title, addedAt: m.addedAt, year: m.year, rating: m.rating }));
  }
  return paginate(items, q);
}

export function movieDetails(ctx: VideoBrowseContext, user: BrowseUser, id: number): PlayerMovieDetails | null {
  const facts = playableMovies(ctx, user).find((m) => m.row.id === id);
  if (!facts) return null;
  const { row } = facts;
  const key = itemKey('movie', id);
  const progress = progressFor(ctx, user, [key]).get(key);
  const versions = versionsOf(ctx.db, movieFiles(ctx.db, id));
  if (versions.length === 0) return null;
  const value = (k: string) => (row.ratings[k]?.value ? row.ratings[k]!.value : null);
  return {
    ...toPlayerMovie(ctx, facts, progress),
    originalTitle: row.originalTitle && row.originalTitle !== row.title ? row.originalTitle : null,
    overview: row.overview || null,
    logoUrl: imageUrl(ctx.basePath, 'movie', id, row.images, 'logo', '780'),
    ratings: { tmdb: value('tmdb'), imdb: value('imdb'), rottenTomatoes: value('rottenTomatoes') },
    studio: row.studio,
    collection: row.collection?.title ?? null,
    versions: versions.map((v) => ({
      ...toVersion(v),
      badges: badgesOf(v.info),
      description: versionDescription(v.info),
      sizeBytes: v.file.sizeBytes,
      audioLanguages: [...new Set(v.info.audioTracks.flatMap((a) => (a.language ? [a.language] : [])))],
      subtitleLanguages: [...new Set(v.info.subtitleTracks.flatMap((s) => (s.language ? [s.language] : [])))],
    })),
  };
}

// ---- series ------------------------------------------------------------------------------------

export interface SeriesFacts {
  row: SeriesRow;
  addedAt: string | null;
  episodeKeys: string[];
  badges: string[];
}

interface SeriesFileStats {
  seriesId: number;
  addedAt: string | null;
  maxHeight: number | null;
  maxWidth: number | null;
  ranges: string | null;
}

/** Series with at least one episode file within the caps, with per-series file facts (one SQL pass). */
export function playableSeries(ctx: VideoBrowseContext, user: BrowseUser): SeriesFacts[] {
  const r = restrictionsOf(user);
  const rows = ctx.db.select().from(series).all().filter((s) => withinRestrictions(r, 'series', s.certification));
  if (rows.length === 0) return [];
  const eps = ctx.db
    .select({ id: episodes.id, seriesId: episodes.seriesId })
    .from(episodes)
    .where(and(eq(episodes.hasFile, true), isNotNull(episodes.episodeFileId)))
    .all();
  const keys = new Map<number, string[]>();
  for (const e of eps) {
    const list = keys.get(e.seriesId) ?? [];
    list.push(itemKey('episode', e.id));
    keys.set(e.seriesId, list);
  }
  const stats = new Map(
    ctx.db
      .all<SeriesFileStats>(
        sql`SELECT series_id AS seriesId, max(date_added) AS addedAt,
              max(CAST(json_extract(media_info, '$.height') AS INTEGER)) AS maxHeight,
              max(CAST(json_extract(media_info, '$.width') AS INTEGER)) AS maxWidth,
              group_concat(DISTINCT json_extract(media_info, '$.videoDynamicRangeType')) AS ranges
            FROM media_files WHERE media_type = 'series' AND series_id IS NOT NULL GROUP BY series_id`,
      )
      .map((s) => [s.seriesId, s]),
  );
  return rows.flatMap((row) => {
    const episodeKeys = keys.get(row.id);
    if (!episodeKeys || episodeKeys.length === 0) return [];
    const st = stats.get(row.id);
    const badges: string[] = [];
    if (resolutionLabel(st?.maxWidth ?? null, st?.maxHeight ?? null) === '4K') badges.push('4K');
    const ranges = (st?.ranges ?? '').split(',').map((x) => dynamicRangeOf({ videoDynamicRangeType: x }));
    if (ranges.some((x) => x === 'hdr10' || x === 'hdr10plus' || x === 'hlg')) badges.push('HDR');
    if (ranges.includes('dv')) badges.push('DV');
    return [{ row, addedAt: st?.addedAt ?? null, episodeKeys, badges }];
  });
}

function toPlayerSeries(ctx: VideoBrowseContext, s: SeriesFacts, progress: Map<string, PlaybackProgress>): PlayerSeries {
  const { row } = s;
  return {
    id: row.id,
    title: row.title,
    year: row.year || null,
    posterUrl: imageUrl(ctx.basePath, 'series', row.id, row.images, 'poster', '342'),
    backdropUrl: imageUrl(ctx.basePath, 'series', row.id, row.images, 'fanart', '1280'),
    certification: row.certification,
    rating: ratingOf(row.ratings),
    genres: row.genres,
    network: row.network,
    status: row.status,
    addedAt: s.addedAt,
    episodeCount: s.episodeKeys.length,
    playedCount: s.episodeKeys.filter((k) => progress.get(k)?.played).length,
    badges: s.badges,
  };
}

export function seriesPage(ctx: VideoBrowseContext, user: BrowseUser, q: VideoBrowseQuery): PlayerSeriesPage {
  const all = playableSeries(ctx, user);
  const { list, ranked } = filterList(
    all,
    q,
    (s) => s.row.title,
    (s) => s.row.sortTitle || s.row.title,
    (s) => s.row.genres,
  );
  const progress = progressFor(
    ctx,
    user,
    list.flatMap((s) => s.episodeKeys),
  );
  let items = list.map((s) => toPlayerSeries(ctx, s, progress));
  if (q.watched !== 'all') items = items.filter((s) => (s.playedCount >= s.episodeCount) === (q.watched === 'watched'));
  if (!ranked) {
    const sortTitles = new Map(list.map((s) => [s.row.id, s.row.sortTitle || s.row.title]));
    items = sortList(items, q, (s) => ({ title: s.title, sortTitle: sortTitles.get(s.id) ?? s.title, addedAt: s.addedAt, year: s.year, rating: s.rating }));
  }
  return paginate(items, q);
}

/**
 * What "Play" on a series starts: the in-progress episode played most recently, else the first
 * unplayed episode after the furthest played one, else the first unplayed one; null when all are played.
 */
export function seriesNextUp(list: readonly EpisodeRow[], progress: Map<string, PlaybackProgress>): EpisodeRow | null {
  const p = (e: EpisodeRow) => progress.get(itemKey('episode', e.id));
  const resuming = list.filter((e) => inProgress(p(e))).sort((a, b) => (p(b)!.lastPlayedAt ?? '').localeCompare(p(a)!.lastPlayedAt ?? ''))[0];
  if (resuming) return resuming;
  const regular = list.filter((e) => e.seasonNumber !== 0);
  let lastPlayed = -1;
  regular.forEach((e, i) => {
    if (p(e)?.played) lastPlayed = i;
  });
  const after = regular.slice(lastPlayed + 1).find((e) => !p(e)?.played);
  return after ?? list.find((e) => !p(e)?.played) ?? null;
}

function toPlayerEpisode(ctx: VideoBrowseContext, e: EpisodeRow, progress: PlaybackProgress | undefined): PlayerEpisode {
  return {
    itemKey: itemKey('episode', e.id),
    id: e.id,
    seasonNumber: e.seasonNumber,
    episodeNumber: e.episodeNumber,
    title: e.title && e.title !== 'TBA' ? e.title : null,
    overview: e.overview || null,
    airDate: e.airDate,
    runtimeMinutes: e.runtimeMinutes,
    thumbUrl: videoArtworkUrl(ctx.basePath, 'episode', e.id),
    progress: toVideoProgress(progress),
    played: progress?.played ?? false,
  };
}

export function seriesDetails(ctx: VideoBrowseContext, user: BrowseUser, id: number): PlayerSeriesDetails | null {
  const facts = playableSeries(ctx, user).find((s) => s.row.id === id);
  if (!facts) return null;
  const list = playableEpisodes(ctx.db, id);
  const progress = progressFor(
    ctx,
    user,
    list.map((e) => itemKey('episode', e.id)),
  );
  const seasons = new Map<number, EpisodeRow[]>();
  for (const e of list) seasons.set(e.seasonNumber, [...(seasons.get(e.seasonNumber) ?? []), e]);
  const seasonList: PlayerSeason[] = [...seasons.entries()]
    .sort((a, b) => seasonOrder(a[0]) - seasonOrder(b[0]))
    .map(([n, eps]) => {
      const items = eps.map((e) => toPlayerEpisode(ctx, e, progress.get(itemKey('episode', e.id))));
      return { seasonNumber: n, title: n === 0 ? 'Specials' : `Season ${n}`, episodeCount: items.length, playedCount: items.filter((e) => e.played).length, episodes: items };
    });
  const next = seriesNextUp(list, progress);
  return {
    ...toPlayerSeries(ctx, facts, progress),
    originalTitle: null,
    overview: facts.row.overview || null,
    logoUrl: imageUrl(ctx.basePath, 'series', id, facts.row.images, 'logo', '780'),
    seasons: seasonList,
    nextUp: next ? itemKey('episode', next.id) : null,
  };
}

// ---- home --------------------------------------------------------------------------------------

export function movieCard(ctx: VideoBrowseContext, m: MovieFacts, progress: PlaybackProgress | undefined): VideoCard {
  const { row } = m;
  return {
    itemKey: itemKey('movie', row.id),
    kind: 'movie',
    id: row.id,
    title: row.title,
    subtitle: null,
    year: row.year || null,
    posterUrl: imageUrl(ctx.basePath, 'movie', row.id, row.images, 'poster', '342'),
    backdropUrl: imageUrl(ctx.basePath, 'movie', row.id, row.images, 'fanart', '1280'),
    thumbUrl: null,
    progress: toVideoProgress(progress),
    badges: m.badges,
  };
}

/** A series card (itemKey null: opening it shows the series). */
export function seriesCard(ctx: VideoBrowseContext, s: SeriesFacts): VideoCard {
  const { row } = s;
  return {
    itemKey: null,
    kind: 'series',
    id: row.id,
    title: row.title,
    subtitle: row.network,
    year: row.year || null,
    posterUrl: imageUrl(ctx.basePath, 'series', row.id, row.images, 'poster', '342'),
    backdropUrl: imageUrl(ctx.basePath, 'series', row.id, row.images, 'fanart', '1280'),
    thumbUrl: null,
    progress: null,
    badges: s.badges,
  };
}

function episodeCard(ctx: VideoBrowseContext, e: EpisodeRow, show: SeriesRow, progress: PlaybackProgress | undefined, badges: string[] = []): VideoCard {
  const title = e.title && e.title !== 'TBA' ? e.title : null;
  return {
    itemKey: itemKey('episode', e.id),
    kind: 'episode',
    id: e.id,
    title: show.title,
    subtitle: title ? `${episodeCode(e)} · ${title}` : episodeCode(e),
    year: show.year || null,
    posterUrl: imageUrl(ctx.basePath, 'series', show.id, show.images, 'poster', '342'),
    backdropUrl: imageUrl(ctx.basePath, 'series', show.id, show.images, 'fanart', '1280'),
    thumbUrl: videoArtworkUrl(ctx.basePath, 'episode', e.id),
    progress: toVideoProgress(progress),
    seriesId: show.id,
    seasonNumber: e.seasonNumber,
    episodeNumber: e.episodeNumber,
    badges,
  };
}

/** Episodes with a file by id, with their series, within the caps. */
export function episodesWithSeries(ctx: VideoBrowseContext, r: ContentRestrictions | null, ids: readonly number[]): Map<number, { episode: EpisodeRow; show: SeriesRow }> {
  const out = new Map<number, { episode: EpisodeRow; show: SeriesRow }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = ctx.db
      .select({ episode: episodes, show: series })
      .from(episodes)
      .innerJoin(series, eq(series.id, episodes.seriesId))
      .where(and(inArray(episodes.id, ids.slice(i, i + CHUNK)), eq(episodes.hasFile, true), isNotNull(episodes.episodeFileId)))
      .all();
    for (const row of rows) if (withinRestrictions(r, 'series', row.show.certification)) out.set(row.episode.id, row);
  }
  return out;
}

export function videoHome(ctx: VideoBrowseContext, user: BrowseUser): VideoHome {
  const r = restrictionsOf(user);
  const nowMs = ctx.now?.() ?? Date.now();
  const movieList = playableMovies(ctx, user);
  const movieById = new Map(movieList.map((m) => [m.row.id, m]));
  const home: VideoHome = { continueWatching: [], nextUp: [], recentMovies: [], recentEpisodes: [], genres: [] };

  if (user.userId !== null) {
    // Continue watching: the newest unfinished movies and episodes.
    const resume = [...ctx.progress.inProgress(user.userId, HOME_ROW * 2, 'movie'), ...ctx.progress.inProgress(user.userId, HOME_ROW * 2, 'episode')].sort((a, b) =>
      (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? ''),
    );
    const resumeEpisodes = episodesWithSeries(
      ctx,
      r,
      resume.flatMap((p) => (p.itemKey.startsWith('episode:') ? [Number(p.itemKey.slice(8))] : [])),
    );
    for (const p of resume) {
      if (home.continueWatching.length >= HOME_ROW) break;
      const id = Number(p.itemKey.split(':')[1]);
      if (p.itemKey.startsWith('movie:')) {
        const m = movieById.get(id);
        if (m) home.continueWatching.push(movieCard(ctx, m, p));
      } else {
        const e = resumeEpisodes.get(id);
        if (e) home.continueWatching.push(episodeCard(ctx, e.episode, e.show, p));
      }
    }

    // Next up: per series watched lately, the first unplayed episode after the furthest played one.
    const since = new Date(nowMs - NEXT_UP_WINDOW_MS).toISOString();
    const lately = ctx.progress.recent(user.userId, 500, 'episode').filter((p) => (p.lastPlayedAt ?? '') >= since);
    const touched = episodesWithSeries(
      ctx,
      r,
      lately.map((p) => Number(p.itemKey.slice(8))),
    );
    const seriesOrder: number[] = [];
    for (const p of lately) {
      const e = touched.get(Number(p.itemKey.slice(8)));
      if (e && !seriesOrder.includes(e.show.id)) seriesOrder.push(e.show.id);
    }
    for (const seriesId of seriesOrder) {
      if (home.nextUp.length >= HOME_ROW) break;
      const list = playableEpisodes(ctx.db, seriesId);
      const progress = progressFor(
        ctx,
        user,
        list.map((e) => itemKey('episode', e.id)),
      );
      // A series with an episode in progress shows under Continue watching instead.
      if (list.some((e) => inProgress(progress.get(itemKey('episode', e.id))))) continue;
      const regular = list.filter((e) => e.seasonNumber !== 0);
      let last = -1;
      regular.forEach((e, i) => {
        if (progress.get(itemKey('episode', e.id))?.played) last = i;
      });
      if (last < 0) continue;
      const next = regular.slice(last + 1).find((e) => !progress.get(itemKey('episode', e.id))?.played);
      const show = [...touched.values()].find((t) => t.show.id === seriesId)!.show;
      if (next) home.nextUp.push(episodeCard(ctx, next, show, progress.get(itemKey('episode', next.id))));
    }
  }

  // Recently added movies.
  const recent = [...movieList].sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? '')).slice(0, HOME_ROW);
  const movieProgress = progressFor(
    ctx,
    user,
    recent.map((m) => itemKey('movie', m.row.id)),
  );
  home.recentMovies = recent.map((m) => movieCard(ctx, m, movieProgress.get(itemKey('movie', m.row.id))));

  // Recently added episodes: newest files first, at most three per series.
  const newest = ctx.db
    .select({ id: episodes.id })
    .from(episodes)
    .innerJoin(mediaFiles, eq(mediaFiles.id, episodes.episodeFileId))
    .where(eq(episodes.hasFile, true))
    .orderBy(desc(mediaFiles.dateAdded), desc(episodes.id))
    .limit(300)
    .all()
    .map((e) => e.id);
  const newestRows = episodesWithSeries(ctx, r, newest);
  const perSeries = new Map<number, number>();
  const picked: Array<{ episode: EpisodeRow; show: SeriesRow }> = [];
  for (const id of newest) {
    const row = newestRows.get(id);
    if (!row || picked.length >= HOME_ROW) continue;
    const n = perSeries.get(row.show.id) ?? 0;
    if (n >= 3) continue;
    perSeries.set(row.show.id, n + 1);
    picked.push(row);
  }
  const episodeProgress = progressFor(
    ctx,
    user,
    picked.map((p) => itemKey('episode', p.episode.id)),
  );
  home.recentEpisodes = picked.map((p) => episodeCard(ctx, p.episode, p.show, episodeProgress.get(itemKey('episode', p.episode.id))));

  const genres = new Set<string>();
  for (const m of movieList) for (const g of m.row.genres) genres.add(g);
  for (const s of playableSeries(ctx, user)) for (const g of s.row.genres) genres.add(g);
  home.genres = [...genres].sort((a, b) => a.localeCompare(b));
  return home;
}

// ---- search and watched ------------------------------------------------------------------------

const SEARCH_TAKE = 20;

export function videoSearch(ctx: VideoBrowseContext, user: BrowseUser, q: string): { movies: PlayerMovie[]; series: PlayerSeries[] } {
  if (!q.trim()) return { movies: [], series: [] };
  const movieHits = rankMatches(
    q,
    playableMovies(ctx, user),
    (m) => m.row.title,
    (m) => [m.row.originalTitle, String(m.row.year)],
  )
    .slice(0, SEARCH_TAKE)
    .map((h) => h.item);
  const seriesHits = rankMatches(
    q,
    playableSeries(ctx, user),
    (s) => s.row.title,
    (s) => [String(s.row.year), s.row.network ?? ''],
  )
    .slice(0, SEARCH_TAKE)
    .map((h) => h.item);
  const progress = progressFor(ctx, user, [...movieHits.map((m) => itemKey('movie', m.row.id)), ...seriesHits.flatMap((s) => s.episodeKeys)]);
  return {
    movies: movieHits.map((m) => toPlayerMovie(ctx, m, progress.get(itemKey('movie', m.row.id)))),
    series: seriesHits.map((s) => toPlayerSeries(ctx, s, progress)),
  };
}

/** Marks items, a series or a season played/unplayed; returns how many items changed. */
export function markWatched(ctx: VideoBrowseContext, userId: number, req: VideoWatchedRequest): number {
  const nowMs = ctx.now?.() ?? Date.now();
  let keys: string[];
  if (req.itemKeys) keys = [...new Set(req.itemKeys)];
  else {
    keys = playableEpisodes(ctx.db, req.seriesId!)
      .filter((e) => req.seasonNumber === undefined || e.seasonNumber === req.seasonNumber)
      .map((e) => itemKey('episode', e.id));
  }
  for (const key of keys) ctx.progress.update(userId, key, { played: req.played }, nowMs);
  return keys.length;
}
