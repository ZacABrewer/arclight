import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PlayerMovieDetails, PlayerSeriesDetails, VideoFeatured, VideoHome, type ProgressReport } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { ownerProfileOf } from '../households/backfill.js';
import { restrictionsOfSettings } from '../requests/certification.js';
import type { BrowseUser } from './browse.js';
import { airWeekday, localDay, seededShuffle, similarMovies, videoFeatured, withHomeRows, withMovieExtras, withSeriesExtras, type FeaturedContext, type TrendingRef } from './featured.js';
import { appHarness, seedMovie, seedSeries, signIn, type AppHarness } from './media-services.fixtures.js';
import { ProgressStore } from './progress.js';
import { movieDetails, seriesDetails, videoHome } from './video-browse.js';

// The rotating hero, the redesign's home rows and the details additions (redesign spec §3.2).

const NOW = Date.parse('2026-05-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const ymd = (ms: number) => iso(ms).slice(0, 10);

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'arclight-featured-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const report = (positionMs: number, durationMs: number, at: number): ProgressReport => ({ event: 'progress', positionMs, durationMs, deviceId: 'test', clientTime: iso(at) });

interface Lib {
  db: Db;
  userId: number;
  /** The account's owner household profile. */
  profileId: number;
  ctx: FeaturedContext;
  ids: Record<string, number> & { resume: number; top: number; weekly: number; ended: number };
  trending: TrendingRef[] | null;
}

/** A small library with one title per hero category, plus decoys. */
async function library(): Promise<Lib> {
  const db = await createTestDb();
  const userId = seedAdmin(db);
  const profileId = ownerProfileOf(db, userId)!.id;
  const owner = { userId, profileId, isOwnerProfile: true };
  const dir = mkdtempSync(join(tmp, 'lib-'));
  const ids = {} as Lib['ids'];
  ids.resume = seedMovie(db, dir, { title: 'Resume Me', tmdbId: 101, genres: ['Drama', 'Thriller'] }).movie.id;
  ids.fresh = seedMovie(db, dir, { title: 'Fresh Arrival', tmdbId: 102, added: iso(NOW - 3 * DAY), genres: ['Comedy'] }).movie.id;
  ids.noBackdrop = seedMovie(db, dir, { title: 'No Backdrop', tmdbId: 103, added: iso(NOW - 2 * DAY), fanart: false }).movie.id;
  ids.trend = seedMovie(db, dir, { title: 'Trend Setter', tmdbId: 104, genres: ['Drama', 'Thriller', 'Mystery'] }).movie.id;
  ids.top = seedMovie(db, dir, { title: 'Top Shelf', tmdbId: 105, score: 8.2, runtimeMinutes: 120, genres: ['Drama'] }).movie.id;
  ids.adult = seedMovie(db, dir, { title: 'Grown Ups Only', tmdbId: 106, certification: 'R', score: 9 }).movie.id;
  ids.long = seedMovie(db, dir, { title: 'Very Long', tmdbId: 107, score: 7, runtimeMinutes: 190 }).movie.id;
  ids.tonight = seedMovie(db, dir, { title: 'Tonight Pick', tmdbId: 108, score: 6.8, runtimeMinutes: 95, genres: ['Drama', 'Thriller'] }).movie.id;

  // Sundays: 2026-04-19, 04-26, 05-03.
  const weekly = seedSeries(db, dir, {
    title: 'Weekly Show',
    tmdbId: 201,
    status: 'continuing',
    episodes: [
      { season: 1, episode: 1, airDate: '2026-04-19' },
      { season: 1, episode: 2, airDate: '2026-04-26' },
      { season: 1, episode: 3, airDate: '2026-05-03', dateAdded: iso(NOW - 1 * DAY) },
      { season: 1, episode: 4, airDate: '2026-05-17', file: false },
    ],
  });
  ids.weekly = weekly.show.id;
  ids.ended = seedSeries(db, dir, {
    title: 'Ended Show',
    tmdbId: 202,
    status: 'ended',
    episodes: [
      { season: 1, episode: 1, airDate: '2020-01-01' },
      { season: 1, episode: 2, airDate: '2020-01-08', dateAdded: iso(NOW - 2 * DAY) },
    ],
  }).show.id;
  ids.third = seedSeries(db, dir, { title: 'Third New', tmdbId: 203, episodes: [{ season: 1, episode: 1, airDate: '2026-05-01', dateAdded: iso(NOW - 3 * DAY) }] }).show.id;

  const progress = new ProgressStore(db);
  progress.report(owner, `movie:${ids.resume}`, report(1_800_000, 6_000_000, NOW - DAY), NOW - DAY);
  const lib: Lib = { db, userId, profileId, ids, trending: [], ctx: undefined as unknown as FeaturedContext };
  lib.trending = [
    { mediaType: 'movie', tmdbId: 106 },
    { mediaType: 'movie', tmdbId: 104 },
    { mediaType: 'movie', tmdbId: 101 },
    { mediaType: 'movie', tmdbId: 999 },
  ];
  lib.ctx = { db, basePath: '', progress, now: () => NOW, trending: async () => lib.trending };
  return lib;
}

/** The owner profile of the test account, with the account's settings (content limits). */
const asUser = (lib: Lib, settings: unknown = null): BrowseUser => ({
  userId: lib.userId,
  settings,
  profileId: lib.profileId,
  isOwnerProfile: true,
  restrictions: settings ? restrictionsOfSettings(settings) : null,
});
const kid = (lib: Lib) => asUser(lib, { contentRestrictions: { maxCertification: { movie: 'PG-13', tv: null } } });

describe('featured', () => {
  it('fills the categories in order, once per title, with a backdrop and within limits', async () => {
    const lib = await library();
    const { items } = VideoFeatured.parse(await videoFeatured(lib.ctx, kid(lib), 8));
    expect(items.map((i) => [i.kicker, i.title])).toEqual([
      ['continue', 'Resume Me'],
      ['new-episode', 'Weekly Show'],
      ['new-episode', 'Ended Show'],
      ['just-added', 'Fresh Arrival'],
      ['trending', 'Trend Setter'],
      ['top-rated', 'Top Shelf'],
    ]);
    const weekly = items[1]!;
    expect(weekly.kickerWeekday).toBe(0);
    expect(items[2]!.kickerWeekday).toBeNull();
    expect(weekly).toMatchObject({ kind: 'series', seasonCount: 1, runtimeMinutes: null, inMyList: false });
    expect(weekly.play).toMatchObject({ seasonNumber: 1, episodeNumber: 1 });
    expect(weekly.chips).toMatchObject({ resolution: '1080p', audio: '5.1', certification: 'TV-14' });
    const resume = items[0]!;
    expect(resume.play).toEqual({ itemKey: `movie:${lib.ids.resume}`, seasonNumber: null, episodeNumber: null, progress: { positionMs: 1_800_000, durationMs: 6_000_000, played: false } });
    expect(resume.genres).toEqual(['Drama', 'Thriller']);
    expect(resume.backdropUrl).toBe(`/api/v1/playback/artwork/movie/${lib.ids.resume}?type=fanart&w=1280`);
  });

  it('respects the limit and is stable for the day', async () => {
    const lib = await library();
    const a = await videoFeatured(lib.ctx, asUser(lib), 3);
    const b = await videoFeatured(lib.ctx, asUser(lib), 3);
    expect(a.items).toHaveLength(3);
    expect(a).toEqual(b);
  });

  it('falls back to the most played titles when TMDB trending is unavailable', async () => {
    const lib = await library();
    lib.trending = null;
    const profileId = lib.profileId;
    lib.db.insert(schema.playbackPlays).values({ userId: lib.userId, profileId, itemKey: `movie:${lib.ids.tonight}`, at: iso(NOW - DAY), durationMs: 1 }).run();
    lib.db.insert(schema.playbackPlays).values({ userId: lib.userId, profileId, itemKey: `movie:${lib.ids.tonight}`, at: iso(NOW - 2 * DAY), durationMs: 1 }).run();
    // Too old to count.
    lib.db.insert(schema.playbackPlays).values({ userId: lib.userId, profileId, itemKey: `movie:${lib.ids.long}`, at: iso(NOW - 30 * DAY), durationMs: 1 }).run();
    // Another household profile of the same account: its plays are its own.
    const other = lib.db
      .insert(schema.householdProfiles)
      .values({ userId: lib.userId, name: 'Other', color: '#123456', initial: 'O', createdAt: iso(NOW), updatedAt: iso(NOW) })
      .returning()
      .get();
    for (let i = 1; i <= 3; i++) lib.db.insert(schema.playbackPlays).values({ userId: lib.userId, profileId: other.id, itemKey: `movie:${lib.ids.top}`, at: iso(NOW - i * DAY), durationMs: 1 }).run();
    const { items } = await videoFeatured(lib.ctx, kid(lib), 8);
    expect(items.filter((i) => i.kicker === 'trending').map((i) => i.title)).toEqual(['Tonight Pick']);
  });

  it('the weekday rule needs three aired episodes on one day', async () => {
    const lib = await library();
    expect(airWeekday(lib.db, lib.ids.weekly, NOW)).toBe(0);
    expect(airWeekday(lib.db, lib.ids.ended, NOW)).toBeNull();
  });
});

describe('home rows and details', () => {
  it('adds trending, movies for tonight and the genre lists', async () => {
    const lib = await library();
    const user = kid(lib);
    const home = VideoHome.parse(await withHomeRows(lib.ctx, user, videoHome(lib.ctx, user)));
    expect(home.trending!.map((c) => c.title)).toEqual(['Trend Setter', 'Resume Me']);
    // Unplayed, at most 140 minutes, TMDB 6.5 or better; restricted titles never show.
    expect(home.moviesForTonight!.map((c) => c.title).sort()).toEqual(['Tonight Pick', 'Top Shelf']);
    expect(home.myList).toEqual([]);
    expect(home.movieGenres).toEqual(['Comedy', 'Drama', 'Mystery', 'Thriller']);
    expect(home.seriesGenres).toEqual(['Comedy']);
  });

  it('similar movies: most shared genres first, then score, never itself', async () => {
    const lib = await library();
    const user = asUser(lib);
    expect(similarMovies(lib.ctx, user, lib.ids.resume).map((c) => c.title)).toEqual(['Tonight Pick', 'Trend Setter', 'Grown Ups Only', 'Top Shelf', 'Very Long', 'No Backdrop']);
  });

  it('details carry chips, My List state and similar', async () => {
    const lib = await library();
    const user = asUser(lib);
    const movie = PlayerMovieDetails.parse(await withMovieExtras(lib.ctx, user, movieDetails(lib.ctx, user, lib.ids.top)!));
    expect(movie.chips).toEqual({ resolution: '1080p', dynamicRange: null, audio: '5.1', audioLanguages: ['eng'], sizeBytes: 2000, tmdbScore: 8.2, certification: 'PG-13' });
    expect(movie.inMyList).toBe(false);
    expect(movie.similar!.length).toBeGreaterThan(0);
    // My List is read from the profile's real list.
    lib.db.insert(schema.profileMyList).values({ profileId: lib.profileId, itemKey: `movie:${lib.ids.top}`, addedAt: iso(NOW) }).run();
    expect((await withMovieExtras(lib.ctx, user, movieDetails(lib.ctx, user, lib.ids.top)!)).inMyList).toBe(true);
    expect((await withHomeRows(lib.ctx, user, videoHome(lib.ctx, user))).myList!.map((c) => c.title)).toEqual(['Top Shelf']);
    const show = PlayerSeriesDetails.parse(await withSeriesExtras(lib.ctx, user, seriesDetails(lib.ctx, user, lib.ids.weekly)!));
    expect(show.chips).toMatchObject({ resolution: '1080p', tmdbScore: null, certification: 'TV-14' });
    expect(show.inMyList).toBe(false);
  });

  it('seeded shuffles change with the seed but not between calls', () => {
    const list = Array.from({ length: 20 }, (_, i) => i);
    expect(seededShuffle(list, 'a:1:2026-05-10')).toEqual(seededShuffle(list, 'a:1:2026-05-10'));
    expect(seededShuffle(list, 'a:1:2026-05-10')).not.toEqual(seededShuffle(list, 'a:1:2026-05-11'));
    expect([...seededShuffle(list, 'x')].sort((a, b) => a - b)).toEqual(list);
    expect(localDay(NOW)).toMatch(/^2026-05-1[01]$/);
    expect(ymd(NOW)).toBe('2026-05-10');
  });
});

describe('routes', () => {
  const open: AppHarness[] = [];
  afterEach(async () => {
    for (const h of open.splice(0)) await h.app.close();
  });

  it('GET /playback/video/featured, details and the item pause info over HTTP', async () => {
    const h = await appHarness();
    open.push(h);
    const dir = mkdtempSync(join(tmp, 'http-'));
    const { movie } = seedMovie(h.db, dir, { title: 'Hero Movie', tmdbId: 301, score: 8, added: iso(Date.now() - DAY) });
    const show = seedSeries(h.db, dir, { title: 'Hero Show', tmdbId: 302, episodes: [{ season: 1, episode: 1 }, { season: 1, episode: 2 }] });
    const user = await signIn(h);
    const featured = await h.app.inject({ method: 'GET', url: '/api/v1/playback/video/featured?limit=2', headers: { cookie: user.cookie } });
    expect(featured.statusCode).toBe(200);
    expect(featured.json().items.map((i: { title: string; kicker: string }) => [i.kicker, i.title])).toEqual([['just-added', 'Hero Movie']]);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/playback/video/featured?limit=9', headers: { cookie: user.cookie } })).statusCode).toBe(400);

    const details = (await h.app.inject({ method: 'GET', url: `/api/v1/playback/movies/${movie.id}`, headers: { cookie: user.cookie } })).json();
    expect(details.chips.resolution).toBe('1080p');
    expect(details.similar).toEqual([]);
    const home = (await h.app.inject({ method: 'GET', url: '/api/v1/playback/video/home', headers: { cookie: user.cookie } })).json();
    expect(home.seriesGenres).toEqual(['Comedy']);

    const ep = show.episodes[1]!;
    const item = (await h.app.inject({ method: 'GET', url: `/api/v1/playback/item/episode:${ep.id}`, headers: { cookie: user.cookie } })).json();
    expect(item.pause).toMatchObject({ title: 'Hero Show', episodeTitle: 'Episode 2', seasonNumber: 1, episodeNumber: 2, overview: 'Episode 2 overview.', certification: 'TV-14' });
    expect(item.pause.chips.audio).toBe('5.1');
    // Episode 1 has no overview of its own: the series overview.
    const first = (await h.app.inject({ method: 'GET', url: `/api/v1/playback/item/episode:${show.episodes[0]!.id}`, headers: { cookie: user.cookie } })).json();
    expect(first.pause.overview).toBe('About Hero Show.');
    const movieItem = (await h.app.inject({ method: 'GET', url: `/api/v1/playback/item/movie:${movie.id}`, headers: { cookie: user.cookie } })).json();
    expect(movieItem.pause).toMatchObject({ title: 'Hero Movie', episodeTitle: null, tmdbScore: 8, genres: ['Drama'] });
  });
});
