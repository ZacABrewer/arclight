import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  itemKey,
  type MediaChips,
  type PlaybackProgress,
  type PlayerMovieDetails,
  type PlayerSeriesDetails,
  type VideoCard,
  type VideoFeatured,
  type VideoFeaturedItem,
  type VideoHome,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles } from '../library/schema.js';
import { createMetadataCacheStore } from '../metadata/cache.js';
import { activeMetadataService } from '../metadata/index.js';
import { ownerOfBrowse, type BrowseUser } from './browse.js';
import { mediaChipsOf, tmdbScoreOf } from './media-chips.js';
import { myListHas, myListKeys } from './my-list.js';
import { playbackPlays } from './schema.js';
import {
  HOME_ROW,
  inProgress,
  movieCard,
  playableMovies,
  playableSeries,
  progressFor,
  seriesCard,
  seriesNextUp,
  toVideoProgress,
  type MovieFacts,
  type SeriesFacts,
  type VideoBrowseContext,
} from './video-browse.js';
import { episodeFiles, imageUrl, movieFiles, playableEpisodes, versionsOf, type EpisodeRow } from './video-items.js';

// The rotating hero (GET /playback/video/featured), the redesign's extra home rows (trending,
// movies for tonight, My List, genres per type), and the details additions (chips, My List
// state, similar movies). Everything is within the caller's content limits, and every "random"
// choice is seeded by (profile, local date), so the page is stable for the day.

const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_EPISODE_MS = 7 * DAY_MS;
const JUST_ADDED_MS = 14 * DAY_MS;
const TRENDING_TTL_MS = DAY_MS;
const TRENDING_PAGES = 3;
const TRENDING_TIMEOUT_MS = 5_000;
const TONIGHT_MAX_MINUTES = 140;
const TONIGHT_MIN_SCORE = 6.5;
const TOP_RATED_MIN_SCORE = 7.5;
const SIMILAR_MAX = 20;
const CACHE_PROVIDER = 'tmdb';
const CACHE_KEY = 'player:trending:all:week';

/** A title in TMDB's weekly trending list. */
export interface TrendingRef {
  mediaType: 'movie' | 'series';
  tmdbId: number;
}

/** Where trending comes from; null when TMDB is not configured or unreachable (tests inject one). */
export type TrendingSource = (db: Db) => Promise<TrendingRef[] | null>;

export interface FeaturedContext extends VideoBrowseContext {
  trending?: TrendingSource;
}

// ---- seeding ---------------------------------------------------------------------------------

/** The active household profile of a request (0 without one: nothing personal matches). */
export function profileIdOf(user: BrowseUser): number {
  return user.profileId ?? 0;
}

/** YYYY-MM-DD in the server's time zone. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A deterministic [0, 1) generator from a string seed (FNV-1a into mulberry32). */
export function seededRandom(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with a seeded generator (a copy; the input is left alone). */
export function seededShuffle<T>(list: readonly T[], seed: string): T[] {
  const rnd = seededRandom(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const seedOf = (ctx: VideoBrowseContext, user: BrowseUser, what: string) => `${what}:${profileIdOf(user)}:${localDay(ctx.now?.() ?? Date.now())}`;

// ---- trending ----------------------------------------------------------------------------------

const inflight = new WeakMap<Db, Promise<TrendingRef[] | null>>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * TMDB's weekly trending titles (movies and shows), cached a day in the metadata cache. A failed
 * refresh falls back to the stale entry; null when there is neither (not configured, unreachable).
 */
export const tmdbTrending: TrendingSource = async (db) => {
  const store = createMetadataCacheStore(db);
  const fresh = store.get<TrendingRef[]>(CACHE_PROVIDER, CACHE_KEY);
  if (fresh) return fresh.body;
  const service = activeMetadataService();
  if (!service?.isConfigured()) return store.get<TrendingRef[]>(CACHE_PROVIDER, CACHE_KEY, { allowStale: true })?.body ?? null;
  let running = inflight.get(db);
  if (!running) {
    running = (async () => {
      try {
        const client = service.client();
        const refs: TrendingRef[] = [];
        for (let page = 1; page <= TRENDING_PAGES; page++) {
          const res = await withTimeout(client.getTrending('all', 'week', page), TRENDING_TIMEOUT_MS);
          for (const r of res.results) refs.push({ mediaType: r.mediaType === 'series' ? 'series' : 'movie', tmdbId: r.tmdbId });
          if (page >= res.totalPages) break;
        }
        store.set(CACHE_PROVIDER, CACHE_KEY, refs, TRENDING_TTL_MS);
        return refs;
      } catch {
        return store.get<TrendingRef[]>(CACHE_PROVIDER, CACHE_KEY, { allowStale: true })?.body ?? null;
      } finally {
        inflight.delete(db);
      }
    })();
    inflight.set(db, running);
  }
  return running;
};

/** "movie:<id>" / "series:<id>" of the active profile's most played titles in the last 7 days. */
function mostPlayedKeys(ctx: VideoBrowseContext, user: BrowseUser): string[] {
  if (user.userId === null || user.profileId === null) return [];
  const since = new Date((ctx.now?.() ?? Date.now()) - 7 * DAY_MS).toISOString();
  const rows = ctx.db
    .select({ itemKey: playbackPlays.itemKey, n: sql<number>`count(*)` })
    .from(playbackPlays)
    .where(and(eq(playbackPlays.profileId, user.profileId), gte(playbackPlays.at, since)))
    .groupBy(playbackPlays.itemKey)
    .all();
  const episodeIds = rows.flatMap((r) => (r.itemKey.startsWith('episode:') ? [Number(r.itemKey.slice(8))] : []));
  const seriesOf = new Map<number, number>();
  for (let i = 0; i < episodeIds.length; i += 500) {
    for (const e of ctx.db.select({ id: episodes.id, seriesId: episodes.seriesId }).from(episodes).where(inArray(episodes.id, episodeIds.slice(i, i + 500))).all()) seriesOf.set(e.id, e.seriesId);
  }
  const counts = new Map<string, number>();
  for (const r of rows) {
    let key: string | null = null;
    if (r.itemKey.startsWith('movie:')) key = r.itemKey;
    else if (r.itemKey.startsWith('episode:')) {
      const s = seriesOf.get(Number(r.itemKey.slice(8)));
      if (s) key = `series:${s}`;
    }
    if (key) counts.set(key, (counts.get(key) ?? 0) + Number(r.n));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

type Title = { kind: 'movie'; facts: MovieFacts } | { kind: 'series'; facts: SeriesFacts };
const keyOf = (t: Title) => `${t.kind}:${t.facts.row.id}`;

/** The library titles (within limits) in trending order. */
async function trendingTitles(ctx: FeaturedContext, user: BrowseUser, lib: Library): Promise<Title[]> {
  let refs: TrendingRef[] | null = null;
  try {
    refs = await (ctx.trending ?? tmdbTrending)(ctx.db);
  } catch {
    refs = null;
  }
  const out: Title[] = [];
  const seen = new Set<string>();
  const push = (t: Title | undefined) => {
    if (t && !seen.has(keyOf(t))) {
      seen.add(keyOf(t));
      out.push(t);
    }
  };
  if (refs && refs.length > 0) {
    for (const r of refs) push(r.mediaType === 'movie' ? lib.movieByTmdb.get(r.tmdbId) : lib.seriesByTmdb.get(r.tmdbId));
    return out;
  }
  for (const k of mostPlayedKeys(ctx, user)) push(lib.byKey.get(k));
  return out;
}

// ---- the library view --------------------------------------------------------------------------

interface Library {
  movies: MovieFacts[];
  series: SeriesFacts[];
  byKey: Map<string, Title>;
  movieByTmdb: Map<number, Title>;
  seriesByTmdb: Map<number, Title>;
}

function libraryOf(ctx: VideoBrowseContext, user: BrowseUser): Library {
  const movieList = playableMovies(ctx, user);
  const seriesList = playableSeries(ctx, user);
  const byKey = new Map<string, Title>();
  const movieByTmdb = new Map<number, Title>();
  const seriesByTmdb = new Map<number, Title>();
  for (const facts of movieList) {
    const t: Title = { kind: 'movie', facts };
    byKey.set(keyOf(t), t);
    if (facts.row.tmdbId) movieByTmdb.set(facts.row.tmdbId, t);
  }
  for (const facts of seriesList) {
    const t: Title = { kind: 'series', facts };
    byKey.set(keyOf(t), t);
    if (facts.row.tmdbId) seriesByTmdb.set(facts.row.tmdbId, t);
  }
  return { movies: movieList, series: seriesList, byKey, movieByTmdb, seriesByTmdb };
}

const cardOf = (ctx: VideoBrowseContext, t: Title, progress: Map<string, PlaybackProgress>): VideoCard =>
  t.kind === 'movie' ? movieCard(ctx, t.facts, progress.get(itemKey('movie', t.facts.row.id))) : seriesCard(ctx, t.facts);

function cardsOf(ctx: VideoBrowseContext, user: BrowseUser, titles: readonly Title[]): VideoCard[] {
  const progress = progressFor(
    ctx,
    user,
    titles.flatMap((t) => (t.kind === 'movie' ? [itemKey('movie', t.facts.row.id)] : [])),
  );
  return titles.map((t) => cardOf(ctx, t, progress));
}

const sortedGenres = (rows: ReadonlyArray<{ row: { genres: string[] } }>) => [...new Set(rows.flatMap((r) => r.row.genres))].sort((a, b) => a.localeCompare(b));

// ---- home rows ---------------------------------------------------------------------------------

/** Adds the redesign's home rows to a `videoHome` result. */
export async function withHomeRows(ctx: FeaturedContext, user: BrowseUser, home: VideoHome): Promise<VideoHome> {
  const lib = libraryOf(ctx, user);
  const trending = (await trendingTitles(ctx, user, lib)).slice(0, HOME_ROW);

  const movieProgress = progressFor(
    ctx,
    user,
    lib.movies.map((m) => itemKey('movie', m.row.id)),
  );
  const tonight = lib.movies.filter((m) => {
    const score = tmdbScoreOf(m.row.ratings);
    return !movieProgress.get(itemKey('movie', m.row.id))?.played && m.row.runtimeMinutes !== null && m.row.runtimeMinutes > 0 && m.row.runtimeMinutes <= TONIGHT_MAX_MINUTES && score !== null && score >= TONIGHT_MIN_SCORE;
  });
  const tonightPicked = seededShuffle(
    tonight.sort((a, b) => a.row.id - b.row.id),
    seedOf(ctx, user, 'tonight'),
  ).slice(0, HOME_ROW);

  const myList = user.profileId === null ? [] : myListKeys(ctx.db, user.profileId).flatMap((k) => lib.byKey.get(k) ?? []).slice(0, HOME_ROW);

  return {
    ...home,
    trending: cardsOf(ctx, user, trending),
    moviesForTonight: tonightPicked.map((m) => movieCard(ctx, m, movieProgress.get(itemKey('movie', m.row.id)))),
    myList: cardsOf(ctx, user, myList),
    movieGenres: sortedGenres(lib.movies),
    seriesGenres: sortedGenres(lib.series),
  };
}

// ---- details additions -------------------------------------------------------------------------

/** Chips of a movie's default version. */
function movieChips(db: Db, row: MovieFacts['row']): MediaChips {
  const best = versionsOf(db, movieFiles(db, row.id))[0];
  return mediaChipsOf({ file: best ? { sizeBytes: best.file.sizeBytes, mediaInfo: best.file.mediaInfo ?? null } : null, ratings: row.ratings, certification: row.certification });
}

/** Chips of a series: the given episode's default version, the series' score and rating. */
function seriesChips(db: Db, row: SeriesFacts['row'], episode: EpisodeRow | null): MediaChips {
  const best = episode ? versionsOf(db, episodeFiles(db, episode))[0] : undefined;
  return mediaChipsOf({ file: best ? { sizeBytes: best.file.sizeBytes, mediaInfo: best.file.mediaInfo ?? null } : null, ratings: row.ratings, certification: row.certification });
}

/** Library movies with files sharing the most genres with `id`, then by TMDB score. */
export function similarMovies(ctx: VideoBrowseContext, user: BrowseUser, id: number, lib?: Library): VideoCard[] {
  const all = lib?.movies ?? playableMovies(ctx, user);
  const self = all.find((m) => m.row.id === id);
  if (!self || self.row.genres.length === 0) return [];
  const genres = new Set(self.row.genres);
  const scored = all.flatMap((m) => {
    if (m.row.id === id) return [];
    const overlap = m.row.genres.filter((g) => genres.has(g)).length;
    return overlap > 0 ? [{ m, overlap, score: tmdbScoreOf(m.row.ratings) ?? 0 }] : [];
  });
  scored.sort((a, b) => b.overlap - a.overlap || b.score - a.score || a.m.row.title.localeCompare(b.m.row.title) || a.m.row.id - b.m.row.id);
  const picked = scored.slice(0, SIMILAR_MAX).map((s) => s.m);
  const progress = progressFor(
    ctx,
    user,
    picked.map((m) => itemKey('movie', m.row.id)),
  );
  return picked.map((m) => movieCard(ctx, m, progress.get(itemKey('movie', m.row.id))));
}

async function inMyList(ctx: VideoBrowseContext, user: BrowseUser, key: string): Promise<boolean> {
  if (user.profileId === null) return false;
  return (await myListHas(ctx.db, user.profileId, [key])).has(key);
}

export async function withMovieExtras(ctx: VideoBrowseContext, user: BrowseUser, details: PlayerMovieDetails): Promise<PlayerMovieDetails> {
  const facts = playableMovies(ctx, user).find((m) => m.row.id === details.id);
  return {
    ...details,
    chips: facts ? movieChips(ctx.db, facts.row) : null,
    inMyList: await inMyList(ctx, user, `movie:${details.id}`),
    similar: similarMovies(ctx, user, details.id),
  };
}

export async function withSeriesExtras(ctx: VideoBrowseContext, user: BrowseUser, details: PlayerSeriesDetails): Promise<PlayerSeriesDetails> {
  const facts = playableSeries(ctx, user).find((s) => s.row.id === details.id);
  const list = playableEpisodes(ctx.db, details.id);
  const nextId = details.nextUp ? Number(details.nextUp.split(':')[1]) : null;
  const episode = list.find((e) => e.id === nextId) ?? list.find((e) => e.seasonNumber !== 0) ?? list[0] ?? null;
  return {
    ...details,
    chips: facts ? seriesChips(ctx.db, facts.row, episode) : null,
    inMyList: await inMyList(ctx, user, `series:${details.id}`),
  };
}

// ---- featured ----------------------------------------------------------------------------------

/** 0-6 (Sunday first) of a "YYYY-MM-DD" date, or null. */
function weekdayOf(date: string | null): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

/**
 * The weekday a continuing show airs on: its last 3 aired regular episodes share it. Every aired
 * episode counts, with or without a file.
 */
export function airWeekday(db: Db, seriesId: number, nowMs: number): number | null {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const aired = db
    .select({ airDate: episodes.airDate, seasonNumber: episodes.seasonNumber, episodeNumber: episodes.episodeNumber })
    .from(episodes)
    .where(and(eq(episodes.seriesId, seriesId), isNotNull(episodes.airDate)))
    .all()
    .filter((e) => e.seasonNumber > 0 && e.airDate! <= today)
    .sort((a, b) => b.airDate!.localeCompare(a.airDate!) || b.seasonNumber - a.seasonNumber || b.episodeNumber - a.episodeNumber)
    .slice(0, 3);
  if (aired.length < 3) return null;
  const days = aired.map((e) => weekdayOf(e.airDate));
  return days[0] !== null && days.every((d) => d === days[0]) ? days[0]! : null;
}

/** Series with an episode file added since `sinceIso`, newest first. */
function seriesWithNewFiles(db: Db, sinceIso: string): number[] {
  return db
    .select({ seriesId: mediaFiles.seriesId, at: sql<string>`max(${mediaFiles.dateAdded})` })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.mediaType, 'series'), isNotNull(mediaFiles.seriesId), gte(mediaFiles.dateAdded, sinceIso)))
    .groupBy(mediaFiles.seriesId)
    .all()
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((r) => r.seriesId!);
}

const backdropOf = (ctx: VideoBrowseContext, t: Title) => imageUrl(ctx.basePath, t.kind, t.facts.row.id, t.facts.row.images, 'fanart', '1280');

/** Up to `limit` hero items (§3.2): continue, new episodes, just added, My List, trending, top rated. */
export async function videoFeatured(ctx: FeaturedContext, user: BrowseUser, limit: number): Promise<VideoFeatured> {
  const nowMs = ctx.now?.() ?? Date.now();
  const lib = libraryOf(ctx, user);
  const picked: Array<{ title: Title; kicker: VideoFeaturedItem['kicker']; weekday: number | null; resume?: string }> = [];
  const used = new Set<string>();
  const take = (t: Title | undefined, kicker: VideoFeaturedItem['kicker'], extra: { weekday?: number | null; resume?: string } = {}): boolean => {
    if (!t || picked.length >= limit || used.has(keyOf(t)) || !backdropOf(ctx, t)) return false;
    used.add(keyOf(t));
    picked.push({ title: t, kicker, weekday: extra.weekday ?? null, ...(extra.resume ? { resume: extra.resume } : {}) });
    return true;
  };
  const shuffled = (list: readonly Title[], what: string) =>
    seededShuffle(
      [...list].sort((a, b) => keyOf(a).localeCompare(keyOf(b))),
      seedOf(ctx, user, what),
    );

  // 1. The in-progress title with the newest progress.
  const owner = ownerOfBrowse(user);
  if (owner !== null) {
    const resume = [...ctx.progress.inProgress(owner, 20, 'movie'), ...ctx.progress.inProgress(owner, 20, 'episode')].sort((a, b) => (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? ''));
    const episodeSeries = new Map<number, number>();
    const epIds = resume.flatMap((p) => (p.itemKey.startsWith('episode:') ? [Number(p.itemKey.slice(8))] : []));
    if (epIds.length > 0) for (const e of ctx.db.select({ id: episodes.id, seriesId: episodes.seriesId }).from(episodes).where(inArray(episodes.id, epIds)).all()) episodeSeries.set(e.id, e.seriesId);
    for (const p of resume) {
      const [kind, raw] = p.itemKey.split(':');
      const id = Number(raw);
      const t = kind === 'movie' ? lib.byKey.get(`movie:${id}`) : lib.byKey.get(`series:${episodeSeries.get(id) ?? 0}`);
      if (take(t, 'continue', { resume: p.itemKey })) break;
    }
  }

  // 2. Up to two shows with a new episode file this week.
  let newEpisodes = 0;
  for (const seriesId of seriesWithNewFiles(ctx.db, new Date(nowMs - NEW_EPISODE_MS).toISOString())) {
    if (newEpisodes >= 2) break;
    const t = lib.byKey.get(`series:${seriesId}`);
    if (!t || t.kind !== 'series') continue;
    const weekday = t.facts.row.status === 'continuing' ? airWeekday(ctx.db, seriesId, nowMs) : null;
    if (take(t, 'new-episode', { weekday })) newEpisodes++;
  }

  // 3. Movies and shows first added in the last 14 days.
  const since = new Date(nowMs - JUST_ADDED_MS).toISOString();
  const fresh = [...lib.byKey.values()].filter((t) => (t.facts.row.added ?? '') >= since);
  for (const t of shuffled(fresh, 'just-added')) take(t, 'just-added');

  // 4. My List.
  if (user.profileId !== null && picked.length < limit) {
    const keys = myListKeys(ctx.db, user.profileId);
    for (const t of shuffled(
      keys.flatMap((k) => lib.byKey.get(k) ?? []),
      'my-list',
    ))
      take(t, 'my-list');
  }

  // 5. Trending, in TMDB's order.
  if (picked.length < limit) for (const t of await trendingTitles(ctx, user, lib)) take(t, 'trending');

  // 6. Unplayed and well rated.
  if (picked.length < limit) {
    const progress = progressFor(ctx, user, [...lib.movies.map((m) => itemKey('movie', m.row.id)), ...lib.series.flatMap((s) => s.episodeKeys)]);
    const top = [...lib.byKey.values()].filter((t) => {
      const score = tmdbScoreOf(t.facts.row.ratings);
      if (score === null || score < TOP_RATED_MIN_SCORE) return false;
      if (t.kind === 'movie') return !progress.get(itemKey('movie', t.facts.row.id))?.played;
      return !t.facts.episodeKeys.some((k) => progress.get(k)?.played);
    });
    for (const t of shuffled(top, 'top-rated')) take(t, 'top-rated');
  }

  const listed = user.profileId === null ? new Set<string>() : await myListHas(ctx.db, user.profileId, picked.map((p) => keyOf(p.title)));
  return { items: picked.map((p) => featuredItem(ctx, user, p.title, p.kicker, p.weekday, listed.has(keyOf(p.title)), p.resume)) };
}

function featuredItem(ctx: VideoBrowseContext, user: BrowseUser, t: Title, kicker: VideoFeaturedItem['kicker'], weekday: number | null, listed: boolean, resume?: string): VideoFeaturedItem {
  const row = t.facts.row;
  const base = {
    id: row.id,
    title: row.title,
    year: row.year || null,
    certification: row.certification,
    genres: row.genres.slice(0, 3),
    overview: row.overview || null,
    backdropUrl: backdropOf(ctx, t),
    logoUrl: imageUrl(ctx.basePath, t.kind, row.id, row.images, 'logo', '780'),
    kicker,
    kickerWeekday: kicker === 'new-episode' ? weekday : null,
    inMyList: listed,
  };
  if (t.kind === 'movie') {
    const key = itemKey('movie', row.id);
    const progress = progressFor(ctx, user, [key]).get(key);
    return {
      ...base,
      kind: 'movie',
      runtimeMinutes: t.facts.row.runtimeMinutes ?? null,
      seasonCount: null,
      chips: movieChips(ctx.db, t.facts.row),
      play: { itemKey: key, seasonNumber: null, episodeNumber: null, progress: toVideoProgress(progress) },
    };
  }
  const list = playableEpisodes(ctx.db, row.id);
  const progress = progressFor(
    ctx,
    user,
    list.map((e) => itemKey('episode', e.id)),
  );
  const resumeId = resume?.startsWith('episode:') ? Number(resume.slice(8)) : null;
  const episode =
    list.find((e) => e.id === resumeId && inProgress(progress.get(itemKey('episode', e.id)))) ?? seriesNextUp(list, progress) ?? list.find((e) => e.seasonNumber !== 0) ?? list[0] ?? null;
  const seasons = new Set(list.map((e) => e.seasonNumber));
  return {
    ...base,
    kind: 'series',
    runtimeMinutes: null,
    seasonCount: seasons.size,
    chips: seriesChips(ctx.db, t.facts.row, episode),
    play: episode
      ? {
          itemKey: itemKey('episode', episode.id),
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
          progress: toVideoProgress(progress.get(itemKey('episode', episode.id))),
        }
      : null,
  };
}
