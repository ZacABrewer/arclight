import { eq } from 'drizzle-orm';
import { QUALITIES, type MediaInfo, type QualityDefinition, type QualityModel } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import * as s from '../../db/schema.js';
import * as tables from './schema.js';
import { TagRulesService } from './service.js';

// Fixtures for the tag-rules tests: rows are inserted straight into the tables (no files on disk).

export const NOW = new Date('2026-06-01T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

export interface Fixture {
  db: Db;
  service: TagRulesService;
  profileId: number;
}

export async function setup(opts: { batchSize?: number } = {}): Promise<Fixture> {
  const db = await createTestDb(tables);
  const profileId = db
    .insert(s.qualityProfiles)
    .values({ name: 'HD', cutoff: 7, items: [], formatItems: [], languages: [] })
    .returning()
    .get().id;
  const service = new TagRulesService({ db, now: () => NOW, ...(opts.batchSize ? { batchSize: opts.batchSize } : {}) });
  return { db, service, profileId };
}

const q = (def: QualityDefinition) => ({ quality: def, revision: { version: 1, real: 0, isRepack: false } }) as unknown as QualityModel;

let seq = 0;

export interface MovieOpts {
  title?: string;
  year?: number;
  genres?: string[];
  certification?: string | null;
  studio?: string | null;
  originalLanguage?: string;
  collection?: string | null;
  monitored?: boolean;
  tags?: number[];
  addedDaysAgo?: number;
  runtime?: number | null;
  rating?: number | null;
  rootFolderPath?: string;
  status?: 'tba' | 'announced' | 'inCinemas' | 'released' | 'deleted';
}

export function addMovie(fx: Fixture, o: MovieOpts = {}): number {
  const n = ++seq;
  const title = o.title ?? `Movie ${n}`;
  return fx.db
    .insert(s.movies)
    .values({
      tmdbId: 1000 + n,
      title,
      originalTitle: title,
      sortTitle: title.toLowerCase(),
      cleanTitle: title.toLowerCase().replace(/\W/g, ''),
      year: o.year ?? 2010,
      status: o.status ?? 'released',
      studio: o.studio ?? null,
      genres: o.genres ?? [],
      images: [],
      ratings: o.rating ? { tmdb: { votes: 10, value: o.rating } } : {},
      certification: o.certification ?? null,
      originalLanguage: o.originalLanguage ?? 'en',
      collection: o.collection ? { tmdbId: 1, title: o.collection } : null,
      path: `/movies/${title}-${n}`,
      rootFolderPath: o.rootFolderPath ?? '/movies',
      qualityProfileId: fx.profileId,
      monitored: o.monitored ?? true,
      runtimeMinutes: o.runtime ?? null,
      tags: o.tags ?? [],
      added: daysAgo(o.addedDaysAgo ?? 100),
    })
    .returning()
    .get().id;
}

export interface SeriesOpts {
  title?: string;
  year?: number;
  genres?: string[];
  network?: string | null;
  status?: 'continuing' | 'ended' | 'upcoming' | 'deleted';
  seriesType?: 'standard' | 'daily' | 'anime';
  certification?: string | null;
  tags?: number[];
}

export function addSeries(fx: Fixture, o: SeriesOpts = {}): number {
  const n = ++seq;
  const title = o.title ?? `Show ${n}`;
  return fx.db
    .insert(s.series)
    .values({
      tmdbId: 5000 + n,
      title,
      sortTitle: title.toLowerCase(),
      cleanTitle: title.toLowerCase().replace(/\W/g, ''),
      year: o.year ?? 2015,
      status: o.status ?? 'continuing',
      network: o.network ?? null,
      genres: o.genres ?? [],
      images: [],
      ratings: {},
      certification: o.certification ?? null,
      originalLanguage: 'en',
      path: `/tv/${title}-${n}`,
      rootFolderPath: '/tv',
      qualityProfileId: fx.profileId,
      seriesType: o.seriesType ?? 'standard',
      tags: o.tags ?? [],
      added: daysAgo(30),
    })
    .returning()
    .get().id;
}

export function addMovieFile(
  fx: Fixture,
  movieId: number,
  o: { quality?: QualityDefinition; mediaInfo?: MediaInfo | null; sizeBytes?: number; releaseGroup?: string | null; languages?: string[]; versionTag?: string | null } = {},
): number {
  const n = ++seq;
  fx.db.update(s.movies).set({ hasFile: true }).where(eq(s.movies.id, movieId)).run();
  return fx.db
    .insert(s.mediaFiles)
    .values({
      mediaType: 'movie',
      movieId,
      relativePath: `file-${n}.mkv`,
      path: `/movies/file-${n}.mkv`,
      sizeBytes: o.sizeBytes ?? 4 * 1024 ** 3,
      dateAdded: daysAgo(10),
      quality: q(o.quality ?? QUALITIES['Bluray-1080p']),
      languages: o.languages ?? [],
      releaseGroup: o.releaseGroup ?? null,
      mediaInfo: o.mediaInfo ?? null,
      versionTag: o.versionTag ?? null,
    })
    .returning()
    .get().id;
}

export function addEpisodeFile(fx: Fixture, seriesId: number, o: { quality?: QualityDefinition; mediaInfo?: MediaInfo | null } = {}): number {
  const n = ++seq;
  return fx.db
    .insert(s.mediaFiles)
    .values({
      mediaType: 'series',
      seriesId,
      seasonNumber: 1,
      relativePath: `ep-${n}.mkv`,
      path: `/tv/ep-${n}.mkv`,
      sizeBytes: 1024 ** 3,
      dateAdded: daysAgo(5),
      quality: q(o.quality ?? QUALITIES['WEBDL-1080p']),
      languages: [],
      mediaInfo: o.mediaInfo ?? null,
    })
    .returning()
    .get().id;
}

export function addUser(fx: Fixture, username: string): number {
  return fx.db
    .insert(s.users)
    .values({
      username,
      usernameKey: username.toLowerCase(),
      passwordHash: 'disabled$test',
      role: 'user',
      permissions: 0,
      settings: {},
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .returning()
    .get().id;
}

export function addRequest(fx: Fixture, o: { type: 'movie' | 'series'; tmdbId: number; userId: number; status?: 'pending' | 'approved' | 'declined' }): number {
  return fx.db
    .insert(s.mediaRequests)
    .values({
      type: o.type,
      status: o.status ?? 'approved',
      tmdbId: o.tmdbId,
      title: 'x',
      requestedById: o.userId,
      tags: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .returning()
    .get().id;
}

export function addArtist(fx: Fixture, o: { name?: string; genres?: string[]; artistType?: string | null; albums?: Array<{ primaryType: string; secondaryTypes?: string[] }> } = {}): number {
  const n = ++seq;
  const atp =
    fx.db.select().from(s.albumTypeProfiles).get()?.id ??
    fx.db.insert(s.albumTypeProfiles).values({ name: 'Standard', primaryTypes: ['Album'], secondaryTypes: [], releaseStatuses: ['Official'] }).returning().get().id;
  const name = o.name ?? `Artist ${n}`;
  const id = fx.db
    .insert(s.artists)
    .values({
      mbArtistId: `mb-${n}`,
      name,
      sortName: name,
      cleanName: name.toLowerCase(),
      artistType: (o.artistType ?? null) as never,
      genres: o.genres ?? [],
      images: [],
      links: [],
      aliases: [],
      path: `/music/${name}`,
      rootFolderPath: '/music',
      qualityProfileId: fx.profileId,
      albumTypeProfileId: atp,
      tags: [],
      added: daysAgo(3),
    })
    .returning()
    .get().id;
  for (const [i, a] of (o.albums ?? []).entries()) {
    fx.db
      .insert(s.albums)
      .values({
        artistId: id,
        mbReleaseGroupId: `rg-${n}-${i}`,
        title: `Album ${i}`,
        cleanTitle: `album${i}`,
        primaryType: a.primaryType as never,
        secondaryTypes: (a.secondaryTypes ?? []) as never,
        genres: [],
        images: [],
        ratings: {},
        added: daysAgo(3),
      })
      .run();
  }
  return id;
}

export function addAuthor(fx: Fixture, o: { name?: string; books?: Array<{ title: string; narrators?: string[]; series?: string; runtime?: number }> } = {}): number {
  const n = ++seq;
  const name = o.name ?? `Author ${n}`;
  const id = fx.db
    .insert(s.authors)
    .values({
      name,
      sortName: name,
      cleanName: name.toLowerCase(),
      images: [],
      genres: [],
      aliases: [],
      path: `/books/${name}`,
      rootFolderPath: '/books',
      qualityProfileId: fx.profileId,
      languages: [],
      tags: [],
      added: daysAgo(3),
    })
    .returning()
    .get().id;
  for (const b of o.books ?? []) {
    const bookId = fx.db
      .insert(s.books)
      .values({
        authorId: id,
        title: b.title,
        sortTitle: b.title,
        cleanTitle: b.title.toLowerCase(),
        authorCredits: [],
        narrators: b.narrators ?? [],
        runtimeMinutes: b.runtime ?? null,
        genres: [],
        images: [],
        chapters: [],
        ratings: {},
        added: daysAgo(3),
      })
      .returning()
      .get().id;
    if (b.series) {
      const sid =
        fx.db.select().from(s.bookSeries).all().find((x) => x.name === b.series)?.id ??
        fx.db.insert(s.bookSeries).values({ name: b.series, cleanName: b.series.toLowerCase() }).returning().get().id;
      fx.db.insert(s.bookSeriesEntries).values({ seriesId: sid, bookId }).run();
    }
  }
  return id;
}

export function addTag(fx: Fixture, label: string): number {
  return fx.db.insert(s.tags).values({ label }).returning().get().id;
}

/** Labels on an item, sorted. */
export function labelsOf(fx: Fixture, type: 'movie' | 'series' | 'artist' | 'author', id: number): string[] {
  const table = type === 'movie' ? s.movies : type === 'series' ? s.series : type === 'artist' ? s.artists : s.authors;
  const row = fx.db.select({ id: table.id, tags: table.tags }).from(table).all().find((r) => r.id === id);
  const labels = new Map(fx.db.select().from(s.tags).all().map((t) => [t.id, t.label]));
  return (row?.tags ?? []).map((t) => labels.get(t) ?? `#${t}`).sort();
}
