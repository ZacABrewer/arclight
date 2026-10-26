import { and, asc, desc, eq, inArray, like, type SQL } from 'drizzle-orm';
import { statfs, stat, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type {
  AddMovieRequest,
  AddRootFolderRequest,
  AddSeriesRequest,
  BulkMovieUpdateRequest,
  BulkSeriesUpdateRequest,
  Episode,
  EpisodeListQuery,
  ImportExclusion,
  LibraryStatistics,
  MediaFile,
  MediaFileListQuery,
  MediaImage,
  MediaInfo,
  MonitorOption,
  Movie,
  MovieCollection,
  MovieListQuery,
  MovieStatus,
  PageQuery,
  QualityModel,
  Ratings,
  RootFolder,
  Season,
  SeasonStatistics,
  Series,
  SeriesListQuery,
  SeriesStatistics,
  SeriesStatus,
  Tag,
  TagListChange,
  UpdateMovieRequest,
  UpdateSeriesRequest,
  WantedEpisode,
  WantedEpisodesQuery,
} from '@media-tron/shared';
import type { Db } from '../../db/index.js';
import { getSection } from '../settings/service.js';
import { LibraryError } from './errors.js';
import * as t from './schema.js';

// Business logic for the library. Every function is a plain function over a database handle
// and typed inputs; no Fastify, no logger. Writes that touch several tables run in a
// transaction. Time is injected (`now`) so behaviour around air dates is testable.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** A database handle or an open transaction; both run the same query builders. */
export type LibraryDb = Db | Tx;

type SeriesRow = typeof t.series.$inferSelect;
type SeasonRow = typeof t.seasons.$inferSelect;
type EpisodeRow = typeof t.episodes.$inferSelect;
type MovieRow = typeof t.movies.$inferSelect;
type MediaFileRow = typeof t.mediaFiles.$inferSelect;

// ---------------------------------------------------------------------------------------
// Metadata input shapes. The `@media-tron/metadata` package produces these; the library does
// not import it, it only agrees on the fields. Anything unknown may be null or absent.
// ---------------------------------------------------------------------------------------

export interface EpisodeMetadataInput {
  tmdbId?: number | null;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber?: number | null;
  title?: string | null;
  overview?: string | null;
  /** YYYY-MM-DD */
  airDate?: string | null;
  /** Any parseable timestamp; normalised to ISO UTC on write. */
  airDateUtc?: string | null;
  runtimeMinutes?: number | null;
}

export interface SeriesMetadataInput {
  tmdbId: number;
  tvdbId?: number | null;
  imdbId?: string | null;
  title: string;
  year: number;
  overview?: string | null;
  status: SeriesStatus;
  network?: string | null;
  runtimeMinutes?: number | null;
  genres?: string[] | null;
  images?: MediaImage[] | null;
  ratings?: Ratings | null;
  certification?: string | null;
  originalLanguage?: string | null;
  seasons?: ReadonlyArray<{ seasonNumber: number }> | null;
  episodes?: ReadonlyArray<EpisodeMetadataInput> | null;
}

export interface MovieMetadataInput {
  tmdbId: number;
  imdbId?: string | null;
  title: string;
  originalTitle?: string | null;
  year: number;
  overview?: string | null;
  status: MovieStatus;
  inCinemas?: string | null;
  digitalRelease?: string | null;
  physicalRelease?: string | null;
  runtimeMinutes?: number | null;
  studio?: string | null;
  genres?: string[] | null;
  images?: MediaImage[] | null;
  ratings?: Ratings | null;
  certification?: string | null;
  originalLanguage?: string | null;
  collection?: MovieCollection | null;
}

export interface AddMediaFileInput {
  mediaType: 'series' | 'movie';
  seriesId?: number;
  movieId?: number;
  seasonNumber?: number;
  /** Episodes the file covers; required for series files. */
  episodeIds?: number[];
  relativePath: string;
  path: string;
  sizeBytes: number;
  dateAdded?: string;
  quality: QualityModel;
  languages: string[];
  releaseGroup?: string | null;
  sceneName?: string | null;
  edition?: string | null;
  mediaInfo?: MediaInfo | null;
}

export interface EpisodeRefreshResult {
  added: Episode[];
  updated: Episode[];
  removed: Episode[];
}

export interface DeleteMediaOptions {
  deleteFiles?: boolean;
  addExclusion?: boolean;
}

export type IsCutoffMet = (file: MediaFile) => boolean;

const nowIso = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------------------
// Titles and paths
// ---------------------------------------------------------------------------------------

const LEADING_ARTICLES = /^(the|a|an)\s+/i;

/** Lower-case, leading article dropped, used for ordering. */
export function toSortTitle(title: string): string {
  return title.trim().replace(LEADING_ARTICLES, '').toLowerCase();
}

/** Lower-case letters and digits only, used for fuzzy matching against release names. */
export function toCleanTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Make a string safe as a single folder/file name on every filesystem we deploy to.
 * Characters that are illegal on Windows or SMB shares are dropped, a colon becomes " -"
 * (so "Title: Subtitle" reads naturally), whitespace is collapsed, and trailing dots or
 * spaces (which Windows silently strips) are trimmed.
 */
export function sanitizeFolderName(name: string): string {
  const cleaned = name
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[\\/<>?*|"\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'Untitled';
}

export function buildMediaFolderName(title: string, year: number | null | undefined): string {
  const base = sanitizeFolderName(title);
  return year && year > 0 ? `${base} (${year})` : base;
}

export function buildMediaPath(rootFolderPath: string, title: string, year: number | null | undefined): string {
  return join(rootFolderPath, buildMediaFolderName(title, year));
}

function normaliseUtc(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------------------
// Root folders
// ---------------------------------------------------------------------------------------

export async function describeRootFolder(path: string): Promise<{ accessible: boolean; freeSpaceBytes: number | null }> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return { accessible: false, freeSpaceBytes: null };
  } catch {
    return { accessible: false, freeSpaceBytes: null };
  }
  try {
    const fs = await statfs(path);
    return { accessible: true, freeSpaceBytes: Number(fs.bavail) * Number(fs.bsize) };
  } catch {
    return { accessible: true, freeSpaceBytes: null };
  }
}

async function toRootFolder(row: typeof t.rootFolders.$inferSelect): Promise<RootFolder> {
  const info = await describeRootFolder(row.path);
  return { id: row.id, path: row.path, mediaType: row.mediaType, ...info };
}

export async function listRootFolders(db: LibraryDb): Promise<RootFolder[]> {
  const rows = db.select().from(t.rootFolders).orderBy(asc(t.rootFolders.path)).all();
  return Promise.all(rows.map(toRootFolder));
}

export async function getRootFolder(db: LibraryDb, id: number): Promise<RootFolder> {
  const row = db.select().from(t.rootFolders).where(eq(t.rootFolders.id, id)).get();
  if (!row) throw LibraryError.notFound('root folder', id);
  return toRootFolder(row);
}

export async function addRootFolder(db: LibraryDb, req: AddRootFolderRequest): Promise<RootFolder> {
  const path = req.path.trim().replace(/[\\/]+$/, '') || req.path.trim();
  if (!isAbsolute(path)) throw new LibraryError('VALIDATION', 'root folder path must be absolute');

  const info = await describeRootFolder(path);
  if (!info.accessible) {
    throw new LibraryError('ROOT_FOLDER_INACCESSIBLE', `root folder is not an accessible directory: ${path}`);
  }

  for (const existing of db.select().from(t.rootFolders).all()) {
    if (resolve(existing.path) === resolve(path)) {
      throw new LibraryError('CONFLICT', `root folder already exists: ${existing.path}`);
    }
    if (isPathInside(existing.path, path) || isPathInside(path, existing.path)) {
      throw new LibraryError('VALIDATION', `root folders may not nest: ${path} overlaps ${existing.path}`);
    }
  }

  const row = db.insert(t.rootFolders).values({ path, mediaType: req.mediaType }).returning().get();
  return { id: row.id, path: row.path, mediaType: row.mediaType, ...info };
}

export function deleteRootFolder(db: LibraryDb, id: number): void {
  const deleted = db.delete(t.rootFolders).where(eq(t.rootFolders.id, id)).returning().get();
  if (!deleted) throw LibraryError.notFound('root folder', id);
}

function requireRootFolder(db: LibraryDb, path: string, mediaType: 'series' | 'movie'): string {
  const rows = db.select().from(t.rootFolders).where(eq(t.rootFolders.mediaType, mediaType)).all();
  const match = rows.find((r) => resolve(r.path) === resolve(path));
  if (!match) throw new LibraryError('VALIDATION', `${path} is not a registered ${mediaType} root folder`);
  return match.path;
}

// ---------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------

export function listTags(db: LibraryDb): Tag[] {
  return db.select().from(t.tags).orderBy(asc(t.tags.label)).all();
}

export function getTag(db: LibraryDb, id: number): Tag {
  const row = db.select().from(t.tags).where(eq(t.tags.id, id)).get();
  if (!row) throw LibraryError.notFound('tag', id);
  return row;
}

export function createTag(db: LibraryDb, label: string): Tag {
  const normalised = label.trim().toLowerCase();
  const existing = db.select().from(t.tags).where(eq(t.tags.label, normalised)).get();
  if (existing) throw new LibraryError('CONFLICT', `tag already exists: ${normalised}`);
  return db.insert(t.tags).values({ label: normalised }).returning().get();
}

export function updateTag(db: LibraryDb, id: number, label: string): Tag {
  const normalised = label.trim().toLowerCase();
  const clash = db.select().from(t.tags).where(eq(t.tags.label, normalised)).get();
  if (clash && clash.id !== id) throw new LibraryError('CONFLICT', `tag already exists: ${normalised}`);
  const row = db.update(t.tags).set({ label: normalised }).where(eq(t.tags.id, id)).returning().get();
  if (!row) throw LibraryError.notFound('tag', id);
  return row;
}

/** Deletes the tag and removes its id from every series and movie that carried it. */
export function deleteTag(db: Db, id: number): void {
  db.transaction((tx) => {
    const deleted = tx.delete(t.tags).where(eq(t.tags.id, id)).returning().get();
    if (!deleted) throw LibraryError.notFound('tag', id);
    for (const s of tx.select({ id: t.series.id, tags: t.series.tags }).from(t.series).all()) {
      if (s.tags.includes(id)) {
        tx.update(t.series).set({ tags: s.tags.filter((x) => x !== id) }).where(eq(t.series.id, s.id)).run();
      }
    }
    for (const m of tx.select({ id: t.movies.id, tags: t.movies.tags }).from(t.movies).all()) {
      if (m.tags.includes(id)) {
        tx.update(t.movies).set({ tags: m.tags.filter((x) => x !== id) }).where(eq(t.movies.id, m.id)).run();
      }
    }
  });
}

function requireTags(db: LibraryDb, ids: readonly number[]): number[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = new Set(db.select({ id: t.tags.id }).from(t.tags).where(inArray(t.tags.id, unique)).all().map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) throw new LibraryError('VALIDATION', `unknown tag ids: ${missing.join(', ')}`);
  return unique.sort((a, b) => a - b);
}

function applyTagChange(current: number[], change: TagListChange | undefined): number[] {
  if (!change) return current;
  const next = new Set(current);
  for (const id of change.add ?? []) next.add(id);
  for (const id of change.remove ?? []) next.delete(id);
  return [...next].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------
// Statistics (pure)
// ---------------------------------------------------------------------------------------

interface StatEpisode {
  seasonNumber: number;
  monitored: boolean;
  hasFile: boolean;
  airDateUtc: string | null;
}

interface StatFile {
  seasonNumber: number | null;
  sizeBytes: number;
}

export function computeSeasonStatistics(
  episodes: ReadonlyArray<StatEpisode>,
  files: ReadonlyArray<StatFile>,
  now: string,
): SeasonStatistics {
  const nowMs = Date.parse(now);
  let episodeCount = 0;
  let episodeFileCount = 0;
  let monitoredEpisodeCount = 0;
  let nextAiring: string | null = null;
  let previousAiring: string | null = null;

  for (const e of episodes) {
    const airMs = e.airDateUtc ? Date.parse(e.airDateUtc) : Number.NaN;
    const aired = !Number.isNaN(airMs) && airMs <= nowMs;
    if (e.hasFile) episodeFileCount++;
    if (e.monitored) monitoredEpisodeCount++;
    if ((e.monitored && aired) || e.hasFile) episodeCount++;
    if (e.monitored && !Number.isNaN(airMs)) {
      if (airMs >= nowMs) {
        if (!nextAiring || airMs < Date.parse(nextAiring)) nextAiring = new Date(airMs).toISOString();
      } else if (!previousAiring || airMs > Date.parse(previousAiring)) {
        previousAiring = new Date(airMs).toISOString();
      }
    }
  }

  const sizeOnDisk = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  return {
    episodeCount,
    episodeFileCount,
    totalEpisodeCount: episodes.length,
    monitoredEpisodeCount,
    sizeOnDisk,
    percentOfEpisodes: episodeCount === 0 ? 0 : Math.round((episodeFileCount / episodeCount) * 10000) / 100,
    nextAiring,
    previousAiring,
  };
}

export function computeSeriesStatistics(
  seasons: ReadonlyArray<{ seasonNumber: number }>,
  episodes: ReadonlyArray<StatEpisode>,
  files: ReadonlyArray<StatFile>,
  now: string,
): SeriesStatistics {
  return {
    ...computeSeasonStatistics(episodes, files, now),
    seasonCount: seasons.filter((s) => s.seasonNumber > 0).length,
  };
}

// ---------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------

function toEpisode(row: EpisodeRow): Episode {
  return { ...row };
}

function toSeries(row: SeriesRow, seasonRows: SeasonRow[], episodeRows?: EpisodeRow[], fileRows?: MediaFileRow[], now?: string): Series {
  const withStats = episodeRows !== undefined && fileRows !== undefined && now !== undefined;
  const seasons: Season[] = seasonRows
    .slice()
    .sort((a, b) => a.seasonNumber - b.seasonNumber)
    .map((s) => ({
      seasonNumber: s.seasonNumber,
      monitored: s.monitored,
      statistics: withStats
        ? computeSeasonStatistics(
            episodeRows.filter((e) => e.seasonNumber === s.seasonNumber),
            fileRows.filter((f) => f.seasonNumber === s.seasonNumber),
            now,
          )
        : null,
    }));
  return {
    ...row,
    seasons,
    statistics: withStats ? computeSeriesStatistics(seasonRows, episodeRows, fileRows, now) : null,
  };
}

function seriesMetadataColumns(meta: SeriesMetadataInput) {
  return {
    tmdbId: meta.tmdbId,
    tvdbId: meta.tvdbId ?? null,
    imdbId: meta.imdbId ?? null,
    title: meta.title,
    sortTitle: toSortTitle(meta.title),
    cleanTitle: toCleanTitle(meta.title),
    year: meta.year,
    overview: meta.overview ?? '',
    status: meta.status,
    network: meta.network ?? null,
    runtimeMinutes: meta.runtimeMinutes ?? null,
    genres: meta.genres ?? [],
    images: meta.images ?? [],
    ratings: meta.ratings ?? {},
    certification: meta.certification ?? null,
    originalLanguage: meta.originalLanguage ?? 'en',
  };
}

function episodeMetadataColumns(e: EpisodeMetadataInput) {
  return {
    tmdbId: e.tmdbId ?? null,
    seasonNumber: e.seasonNumber,
    episodeNumber: e.episodeNumber,
    absoluteEpisodeNumber: e.absoluteEpisodeNumber ?? null,
    title: e.title?.trim() || 'TBA',
    overview: e.overview ?? '',
    airDate: e.airDate ?? null,
    airDateUtc: normaliseUtc(e.airDateUtc),
    runtimeMinutes: e.runtimeMinutes ?? null,
  };
}

/** Season numbers named by the metadata plus any that only appear on episodes. */
function seasonNumbersFrom(meta: SeriesMetadataInput): number[] {
  const numbers = new Set<number>();
  for (const s of meta.seasons ?? []) numbers.add(s.seasonNumber);
  for (const e of meta.episodes ?? []) numbers.add(e.seasonNumber);
  return [...numbers].sort((a, b) => a - b);
}

/** Language profile for a new item: the request's choice, else the subtitles default for the media type. */
function languageProfileFor(db: Db, mediaType: 'series' | 'movie', requested: number | null | undefined): number | null {
  if (requested !== undefined) return requested;
  const s = getSection(db, 'subtitles');
  return (mediaType === 'series' ? s.defaultSeriesProfileId : s.defaultMovieProfileId) ?? null;
}

export function addSeries(db: Db, meta: SeriesMetadataInput, req: AddSeriesRequest, now: string = nowIso()): Series {
  const languageProfileId = languageProfileFor(db, 'series', req.languageProfileId);
  return db.transaction((tx) => {
    if (tx.select({ id: t.series.id }).from(t.series).where(eq(t.series.tmdbId, meta.tmdbId)).get()) {
      throw new LibraryError('CONFLICT', `series with tmdbId ${meta.tmdbId} already exists`);
    }
    const rootFolderPath = requireRootFolder(tx, req.rootFolderPath, 'series');
    const path = buildMediaPath(rootFolderPath, meta.title, meta.year);
    if (tx.select({ id: t.series.id }).from(t.series).where(eq(t.series.path, path)).get()) {
      throw new LibraryError('CONFLICT', `a series already uses the path ${path}`);
    }
    const tags = requireTags(tx, req.tags);

    const row = tx
      .insert(t.series)
      .values({
        ...seriesMetadataColumns(meta),
        path,
        rootFolderPath,
        qualityProfileId: req.qualityProfileId,
        monitored: req.monitorOption === 'none' ? false : req.monitored,
        monitorNewItems: req.monitorNewItems,
        seriesType: req.seriesType,
        seasonFolder: req.seasonFolder,
        useSceneNumbering: false,
        languageProfileId,
        tags,
        added: now,
        lastRefreshed: now,
      })
      .returning()
      .get();

    for (const seasonNumber of seasonNumbersFrom(meta)) {
      tx.insert(t.seasons).values({ seriesId: row.id, seasonNumber, monitored: seasonNumber > 0 }).run();
    }
    refreshEpisodes(tx, row.id, meta.episodes ?? [], now);
    applyMonitorOption(tx, row.id, req.monitorOption, now);
    return getSeries(tx, row.id, { includeStatistics: true, now });
  });
}

export function getSeries(db: LibraryDb, id: number, opts: { includeStatistics?: boolean; now?: string } = {}): Series {
  const row = db.select().from(t.series).where(eq(t.series.id, id)).get();
  if (!row) throw LibraryError.notFound('series', id);
  const seasonRows = db.select().from(t.seasons).where(eq(t.seasons.seriesId, id)).all();
  if (opts.includeStatistics === false) return toSeries(row, seasonRows);
  const episodeRows = db.select().from(t.episodes).where(eq(t.episodes.seriesId, id)).all();
  const fileRows = db.select().from(t.mediaFiles).where(eq(t.mediaFiles.seriesId, id)).all();
  return toSeries(row, seasonRows, episodeRows, fileRows, opts.now ?? nowIso());
}

export function findSeriesByTmdbId(db: LibraryDb, tmdbId: number): Series | null {
  const row = db.select().from(t.series).where(eq(t.series.tmdbId, tmdbId)).get();
  return row ? getSeries(db, row.id, { includeStatistics: false }) : null;
}

const seriesSortColumns = {
  sortTitle: t.series.sortTitle,
  added: t.series.added,
  year: t.series.year,
  status: t.series.status,
  qualityProfileId: t.series.qualityProfileId,
  path: t.series.path,
} as const;

export function listSeries(db: LibraryDb, query: SeriesListQuery, now: string = nowIso()): Series[] {
  const where: SQL[] = [];
  if (query.monitored !== undefined) where.push(eq(t.series.monitored, query.monitored));
  if (query.status) where.push(eq(t.series.status, query.status));
  if (query.seriesType) where.push(eq(t.series.seriesType, query.seriesType));
  if (query.qualityProfileId !== undefined) where.push(eq(t.series.qualityProfileId, query.qualityProfileId));
  if (query.rootFolderPath) where.push(eq(t.series.rootFolderPath, query.rootFolderPath));
  if (query.tmdbId !== undefined) where.push(eq(t.series.tmdbId, query.tmdbId));
  if (query.search) where.push(like(t.series.cleanTitle, `%${toCleanTitle(query.search)}%`));

  const column = seriesSortColumns[query.sortKey];
  const rows = db
    .select()
    .from(t.series)
    .where(where.length ? and(...where) : undefined)
    .orderBy(query.sortOrder === 'desc' ? desc(column) : asc(column), asc(t.series.id))
    .all()
    .filter((r) => query.tag === undefined || r.tags.includes(query.tag));

  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const seasonRows = groupBy(db.select().from(t.seasons).where(inArray(t.seasons.seriesId, ids)).all(), (s) => s.seriesId);
  if (!query.includeStatistics) return rows.map((r) => toSeries(r, seasonRows.get(r.id) ?? []));

  const episodeRows = groupBy(db.select().from(t.episodes).where(inArray(t.episodes.seriesId, ids)).all(), (e) => e.seriesId);
  const fileRows = groupBy(
    db.select().from(t.mediaFiles).where(inArray(t.mediaFiles.seriesId, ids)).all(),
    (f) => f.seriesId ?? -1,
  );
  return rows.map((r) =>
    toSeries(r, seasonRows.get(r.id) ?? [], episodeRows.get(r.id) ?? [], fileRows.get(r.id) ?? [], now),
  );
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export function updateSeries(db: Db, id: number, req: UpdateSeriesRequest, now: string = nowIso()): Series {
  return db.transaction((tx) => {
    const current = tx.select().from(t.series).where(eq(t.series.id, id)).get();
    if (!current) throw LibraryError.notFound('series', id);

    const patch: Partial<typeof t.series.$inferInsert> = {};
    if (req.monitored !== undefined) patch.monitored = req.monitored;
    if (req.monitorNewItems !== undefined) patch.monitorNewItems = req.monitorNewItems;
    if (req.qualityProfileId !== undefined) patch.qualityProfileId = req.qualityProfileId;
    if (req.seriesType !== undefined) patch.seriesType = req.seriesType;
    if (req.seasonFolder !== undefined) patch.seasonFolder = req.seasonFolder;
    if (req.useSceneNumbering !== undefined) patch.useSceneNumbering = req.useSceneNumbering;
    if (req.languageProfileId !== undefined) patch.languageProfileId = req.languageProfileId;
    if (req.tags !== undefined) patch.tags = requireTags(tx, req.tags);

    if (req.rootFolderPath !== undefined) {
      patch.rootFolderPath = requireRootFolder(tx, req.rootFolderPath, 'series');
      // Moving the folder itself is the organizer's job; the library only records where it lives.
      patch.path = req.path ?? buildMediaPath(patch.rootFolderPath, current.title, current.year);
    } else if (req.path !== undefined) {
      patch.path = req.path;
    }
    if (patch.path && patch.path !== current.path) {
      const clash = tx.select({ id: t.series.id }).from(t.series).where(eq(t.series.path, patch.path)).get();
      if (clash) throw new LibraryError('CONFLICT', `a series already uses the path ${patch.path}`);
    }

    if (Object.keys(patch).length > 0) tx.update(t.series).set(patch).where(eq(t.series.id, id)).run();
    for (const s of req.seasons ?? []) setSeasonMonitored(tx, id, s.seasonNumber, s.monitored);
    return getSeries(tx, id, { now });
  });
}

export function bulkUpdateSeries(db: Db, req: BulkSeriesUpdateRequest, now: string = nowIso()): Series[] {
  return db.transaction((tx) => {
    const rows = tx.select().from(t.series).where(inArray(t.series.id, req.ids)).all();
    const found = new Set(rows.map((r) => r.id));
    const missing = req.ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw LibraryError.notFound('series', missing.join(', '));

    const rootFolderPath = req.rootFolderPath !== undefined ? requireRootFolder(tx, req.rootFolderPath, 'series') : undefined;
    if (req.tags) requireTags(tx, [...(req.tags.add ?? []), ...(req.tags.remove ?? [])]);

    for (const row of rows) {
      const patch: Partial<typeof t.series.$inferInsert> = {};
      if (req.monitored !== undefined) patch.monitored = req.monitored;
      if (req.monitorNewItems !== undefined) patch.monitorNewItems = req.monitorNewItems;
      if (req.qualityProfileId !== undefined) patch.qualityProfileId = req.qualityProfileId;
      if (req.seriesType !== undefined) patch.seriesType = req.seriesType;
      if (req.seasonFolder !== undefined) patch.seasonFolder = req.seasonFolder;
      if (rootFolderPath !== undefined) {
        patch.rootFolderPath = rootFolderPath;
        patch.path = buildMediaPath(rootFolderPath, row.title, row.year);
      }
      if (req.tags) patch.tags = applyTagChange(row.tags, req.tags);
      if (Object.keys(patch).length > 0) tx.update(t.series).set(patch).where(eq(t.series.id, row.id)).run();
      if (req.monitored === true && req.monitorOption) applyMonitorOption(tx, row.id, req.monitorOption, now);
    }
    return req.ids.map((id) => getSeries(tx, id, { now }));
  });
}

export function setSeasonMonitored(db: LibraryDb, seriesId: number, seasonNumber: number, monitored: boolean): Series {
  const season = db
    .select()
    .from(t.seasons)
    .where(and(eq(t.seasons.seriesId, seriesId), eq(t.seasons.seasonNumber, seasonNumber)))
    .get();
  if (!season) throw LibraryError.notFound(`season ${seasonNumber} of series`, seriesId);
  db.update(t.seasons).set({ monitored }).where(eq(t.seasons.id, season.id)).run();
  // A season's flag is the default for its episodes: toggling it toggles them all.
  db.update(t.episodes)
    .set({ monitored })
    .where(and(eq(t.episodes.seriesId, seriesId), eq(t.episodes.seasonNumber, seasonNumber)))
    .run();
  return getSeries(db, seriesId);
}

/**
 * Set monitored flags on every episode and season of a series according to a monitor option.
 * Specials (season 0) are never monitored by an option; the user toggles them explicitly.
 */
export function applyMonitorOption(db: LibraryDb, seriesId: number, option: MonitorOption, now: string = nowIso()): void {
  const seriesRow = db.select().from(t.series).where(eq(t.series.id, seriesId)).get();
  if (!seriesRow) throw LibraryError.notFound('series', seriesId);
  const episodeRows = db.select().from(t.episodes).where(eq(t.episodes.seriesId, seriesId)).all();
  const seasonRows = db.select().from(t.seasons).where(eq(t.seasons.seriesId, seriesId)).all();

  const regular = seasonRows.map((s) => s.seasonNumber).filter((n) => n > 0);
  const firstSeason = regular.length ? Math.min(...regular) : 0;
  const lastSeason = regular.length ? Math.max(...regular) : 0;
  const nowMs = Date.parse(now);

  const shouldMonitor = (e: EpisodeRow): boolean => {
    if (e.seasonNumber === 0) return false;
    switch (option) {
      case 'all':
        return true;
      case 'none':
        return false;
      case 'future': {
        if (!e.airDateUtc) return true;
        return Date.parse(e.airDateUtc) >= nowMs;
      }
      case 'missing':
        return !e.hasFile;
      case 'existing':
        return e.hasFile;
      case 'firstSeason':
        return e.seasonNumber === firstSeason;
      case 'latestSeason':
        return e.seasonNumber === lastSeason;
      case 'pilot':
        return e.seasonNumber === firstSeason && e.episodeNumber === 1;
    }
  };

  const monitoredSeasons = new Set<number>();
  for (const e of episodeRows) {
    const monitored = shouldMonitor(e);
    if (monitored) monitoredSeasons.add(e.seasonNumber);
    if (monitored !== e.monitored) db.update(t.episodes).set({ monitored }).where(eq(t.episodes.id, e.id)).run();
  }

  const upcoming = seriesRow.status === 'continuing' || seriesRow.status === 'upcoming';
  for (const s of seasonRows) {
    let monitored: boolean;
    if (option === 'none' || s.seasonNumber === 0) {
      monitored = false;
    } else if (s.seasonNumber === lastSeason && (option === 'all' || (option === 'future' && upcoming))) {
      // The newest season stays monitored so episodes that appear later are wanted.
      monitored = true;
    } else if (option === 'pilot' && s.seasonNumber === firstSeason) {
      monitored = false;
    } else {
      monitored = monitoredSeasons.has(s.seasonNumber);
    }
    if (monitored !== s.monitored) db.update(t.seasons).set({ monitored }).where(eq(t.seasons.id, s.id)).run();
  }
}

/**
 * Reconcile the episode list of a series with what the metadata source reports. Existing rows
 * keep their monitored / file state and get fresh metadata; new rows inherit the season's
 * flag (new seasons follow the series' monitorNewItems); rows the source no longer lists are
 * deleted, and any file linked only to removed episodes is unlinked so it can be re-imported.
 */
export function refreshEpisodes(
  db: LibraryDb,
  seriesId: number,
  remote: ReadonlyArray<EpisodeMetadataInput>,
  now: string = nowIso(),
): EpisodeRefreshResult {
  const seriesRow = db.select().from(t.series).where(eq(t.series.id, seriesId)).get();
  if (!seriesRow) throw LibraryError.notFound('series', seriesId);

  const existing = new Map<string, EpisodeRow>();
  for (const e of db.select().from(t.episodes).where(eq(t.episodes.seriesId, seriesId)).all()) {
    existing.set(`${e.seasonNumber}:${e.episodeNumber}`, e);
  }
  const seasonMonitored = new Map<number, boolean>();
  for (const s of db.select().from(t.seasons).where(eq(t.seasons.seriesId, seriesId)).all()) {
    seasonMonitored.set(s.seasonNumber, s.monitored);
  }

  const added: Episode[] = [];
  const updated: Episode[] = [];
  const seen = new Set<string>();

  for (const r of remote) {
    const key = `${r.seasonNumber}:${r.episodeNumber}`;
    if (seen.has(key)) continue; // metadata sources occasionally list an episode twice
    seen.add(key);

    if (!seasonMonitored.has(r.seasonNumber)) {
      const monitored = r.seasonNumber > 0 && seriesRow.monitorNewItems === 'all';
      db.insert(t.seasons).values({ seriesId, seasonNumber: r.seasonNumber, monitored }).run();
      seasonMonitored.set(r.seasonNumber, monitored);
    }

    const columns = episodeMetadataColumns(r);
    const current = existing.get(key);
    if (current) {
      existing.delete(key);
      const row = db.update(t.episodes).set(columns).where(eq(t.episodes.id, current.id)).returning().get();
      if (row) updated.push(toEpisode(row));
    } else {
      const monitored = r.seasonNumber === 0 ? false : (seasonMonitored.get(r.seasonNumber) ?? true);
      const row = db
        .insert(t.episodes)
        .values({ ...columns, seriesId, monitored, hasFile: false, episodeFileId: null, unverifiedSceneNumbering: false })
        .returning()
        .get();
      added.push(toEpisode(row));
    }
  }

  const removed: Episode[] = [];
  for (const stale of existing.values()) {
    db.delete(t.episodes).where(eq(t.episodes.id, stale.id)).run();
    removed.push(toEpisode(stale));
  }
  // Seasons that no longer have any episode and were not named by the source vanish too.
  for (const [seasonNumber] of seasonMonitored) {
    if (remote.some((r) => r.seasonNumber === seasonNumber)) continue;
    const remaining = db
      .select({ id: t.episodes.id })
      .from(t.episodes)
      .where(and(eq(t.episodes.seriesId, seriesId), eq(t.episodes.seasonNumber, seasonNumber)))
      .get();
    if (!remaining) {
      db.delete(t.seasons).where(and(eq(t.seasons.seriesId, seriesId), eq(t.seasons.seasonNumber, seasonNumber))).run();
    }
  }

  db.update(t.series).set({ lastRefreshed: now }).where(eq(t.series.id, seriesId)).run();
  return { added, updated, removed };
}

/** Refresh series-level metadata, seasons and episodes together (the metadata module's refresh job). */
export function refreshSeriesMetadata(db: Db, id: number, meta: SeriesMetadataInput, now: string = nowIso()): Series {
  return db.transaction((tx) => {
    const current = tx.select().from(t.series).where(eq(t.series.id, id)).get();
    if (!current) throw LibraryError.notFound('series', id);
    const { tmdbId: _tmdbId, ...columns } = seriesMetadataColumns(meta);
    tx.update(t.series).set({ ...columns, lastRefreshed: now }).where(eq(t.series.id, id)).run();

    const known = new Set(tx.select().from(t.seasons).where(eq(t.seasons.seriesId, id)).all().map((s) => s.seasonNumber));
    for (const seasonNumber of seasonNumbersFrom(meta)) {
      if (known.has(seasonNumber)) continue;
      tx.insert(t.seasons)
        .values({ seriesId: id, seasonNumber, monitored: seasonNumber > 0 && current.monitorNewItems === 'all' })
        .run();
    }
    if (meta.episodes) refreshEpisodes(tx, id, meta.episodes, now);
    return getSeries(tx, id, { now });
  });
}

export async function deleteSeries(db: Db, id: number, opts: DeleteMediaOptions = {}): Promise<void> {
  const row = db.select().from(t.series).where(eq(t.series.id, id)).get();
  if (!row) throw LibraryError.notFound('series', id);
  db.transaction((tx) => {
    if (opts.addExclusion) {
      tx.insert(t.importExclusions)
        .values({ mediaType: 'series', tmdbId: row.tmdbId, title: row.title, year: row.year })
        .onConflictDoNothing()
        .run();
    }
    tx.delete(t.series).where(eq(t.series.id, id)).run(); // cascades to seasons, episodes, media_files
  });
  if (opts.deleteFiles) await removeMediaFolder(row.path, row.rootFolderPath);
}

async function removeMediaFolder(path: string, rootFolderPath: string): Promise<void> {
  // Never delete the root folder itself or anything outside it, whatever the row says.
  if (resolve(path) === resolve(rootFolderPath) || !isPathInside(rootFolderPath, path)) {
    throw new LibraryError('VALIDATION', `refusing to delete ${path}: not inside its root folder ${rootFolderPath}`);
  }
  await rm(path, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------------------

export function listEpisodes(db: LibraryDb, query: EpisodeListQuery): Episode[] {
  const where: SQL[] = [eq(t.episodes.seriesId, query.seriesId)];
  if (query.seasonNumber !== undefined) where.push(eq(t.episodes.seasonNumber, query.seasonNumber));
  if (query.monitored !== undefined) where.push(eq(t.episodes.monitored, query.monitored));
  if (query.hasFile !== undefined) where.push(eq(t.episodes.hasFile, query.hasFile));
  return db
    .select()
    .from(t.episodes)
    .where(and(...where))
    .orderBy(asc(t.episodes.seasonNumber), asc(t.episodes.episodeNumber))
    .all()
    .map(toEpisode);
}

export function getEpisode(db: LibraryDb, id: number): Episode {
  const row = db.select().from(t.episodes).where(eq(t.episodes.id, id)).get();
  if (!row) throw LibraryError.notFound('episode', id);
  return toEpisode(row);
}

export function setEpisodeMonitored(db: LibraryDb, id: number, monitored: boolean): Episode {
  const row = db.update(t.episodes).set({ monitored }).where(eq(t.episodes.id, id)).returning().get();
  if (!row) throw LibraryError.notFound('episode', id);
  return toEpisode(row);
}

export function bulkSetEpisodesMonitored(db: LibraryDb, ids: readonly number[], monitored: boolean): Episode[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  return db.update(t.episodes).set({ monitored }).where(inArray(t.episodes.id, unique)).returning().all().map(toEpisode);
}

// ---------------------------------------------------------------------------------------
// Movies
// ---------------------------------------------------------------------------------------

const RELEASE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function earliest(...dates: Array<string | null | undefined>): number | null {
  const values = dates.map((d) => (d ? Date.parse(d) : Number.NaN)).filter((ms) => !Number.isNaN(ms));
  return values.length ? Math.min(...values) : null;
}

/**
 * Whether a movie may be searched for under its minimum availability. Dates win over the
 * coarse status when known; a movie seen only in cinemas counts as released 90 days later.
 */
export function isMovieAvailable(
  movie: Pick<MovieRow, 'status' | 'minimumAvailability' | 'inCinemas' | 'digitalRelease' | 'physicalRelease'>,
  now: string = nowIso(),
): boolean {
  const nowMs = Date.parse(now);
  if (movie.status === 'deleted') return false;
  switch (movie.minimumAvailability) {
    case 'announced':
      return true;
    case 'inCinemas': {
      const cinema = earliest(movie.inCinemas);
      if (cinema !== null) return cinema <= nowMs;
      return movie.status === 'inCinemas' || movie.status === 'released';
    }
    case 'released': {
      const home = earliest(movie.digitalRelease, movie.physicalRelease);
      if (home !== null) return home <= nowMs;
      const cinema = earliest(movie.inCinemas);
      if (cinema !== null) return cinema + RELEASE_WINDOW_MS <= nowMs;
      return movie.status === 'released';
    }
  }
}

function toMovie(row: MovieRow, files: MediaFileRow[] | undefined, now: string): Movie {
  return {
    ...row,
    isAvailable: isMovieAvailable(row, now),
    statistics: files
      ? { sizeOnDisk: files.reduce((sum, f) => sum + f.sizeBytes, 0), movieFileCount: files.length }
      : null,
  };
}

function movieMetadataColumns(meta: MovieMetadataInput) {
  return {
    tmdbId: meta.tmdbId,
    imdbId: meta.imdbId ?? null,
    title: meta.title,
    originalTitle: meta.originalTitle ?? meta.title,
    sortTitle: toSortTitle(meta.title),
    cleanTitle: toCleanTitle(meta.title),
    year: meta.year,
    overview: meta.overview ?? '',
    status: meta.status,
    inCinemas: meta.inCinemas ?? null,
    digitalRelease: meta.digitalRelease ?? null,
    physicalRelease: meta.physicalRelease ?? null,
    runtimeMinutes: meta.runtimeMinutes ?? null,
    studio: meta.studio ?? null,
    genres: meta.genres ?? [],
    images: meta.images ?? [],
    ratings: meta.ratings ?? {},
    certification: meta.certification ?? null,
    originalLanguage: meta.originalLanguage ?? 'en',
    collection: meta.collection ?? null,
  };
}

export function addMovie(db: Db, meta: MovieMetadataInput, req: AddMovieRequest, now: string = nowIso()): Movie {
  const languageProfileId = languageProfileFor(db, 'movie', req.languageProfileId);
  return db.transaction((tx) => {
    if (tx.select({ id: t.movies.id }).from(t.movies).where(eq(t.movies.tmdbId, meta.tmdbId)).get()) {
      throw new LibraryError('CONFLICT', `movie with tmdbId ${meta.tmdbId} already exists`);
    }
    const rootFolderPath = requireRootFolder(tx, req.rootFolderPath, 'movie');
    const path = buildMediaPath(rootFolderPath, meta.title, meta.year);
    if (tx.select({ id: t.movies.id }).from(t.movies).where(eq(t.movies.path, path)).get()) {
      throw new LibraryError('CONFLICT', `a movie already uses the path ${path}`);
    }
    const tags = requireTags(tx, req.tags);
    const row = tx
      .insert(t.movies)
      .values({
        ...movieMetadataColumns(meta),
        path,
        rootFolderPath,
        qualityProfileId: req.qualityProfileId,
        minimumAvailability: req.minimumAvailability,
        monitored: req.monitored,
        languageProfileId,
        tags,
        added: now,
        lastRefreshed: now,
        hasFile: false,
        movieFileId: null,
      })
      .returning()
      .get();
    return toMovie(row, [], now);
  });
}

export function getMovie(db: LibraryDb, id: number, now: string = nowIso()): Movie {
  const row = db.select().from(t.movies).where(eq(t.movies.id, id)).get();
  if (!row) throw LibraryError.notFound('movie', id);
  const files = db.select().from(t.mediaFiles).where(eq(t.mediaFiles.movieId, id)).all();
  return toMovie(row, files, now);
}

export function findMovieByTmdbId(db: LibraryDb, tmdbId: number, now: string = nowIso()): Movie | null {
  const row = db.select().from(t.movies).where(eq(t.movies.tmdbId, tmdbId)).get();
  return row ? getMovie(db, row.id, now) : null;
}

const movieSortColumns = {
  sortTitle: t.movies.sortTitle,
  added: t.movies.added,
  year: t.movies.year,
  status: t.movies.status,
  inCinemas: t.movies.inCinemas,
  qualityProfileId: t.movies.qualityProfileId,
  path: t.movies.path,
} as const;

export function listMovies(db: LibraryDb, query: MovieListQuery, now: string = nowIso()): Movie[] {
  const where: SQL[] = [];
  if (query.monitored !== undefined) where.push(eq(t.movies.monitored, query.monitored));
  if (query.hasFile !== undefined) where.push(eq(t.movies.hasFile, query.hasFile));
  if (query.status) where.push(eq(t.movies.status, query.status));
  if (query.minimumAvailability) where.push(eq(t.movies.minimumAvailability, query.minimumAvailability));
  if (query.qualityProfileId !== undefined) where.push(eq(t.movies.qualityProfileId, query.qualityProfileId));
  if (query.rootFolderPath) where.push(eq(t.movies.rootFolderPath, query.rootFolderPath));
  if (query.tmdbId !== undefined) where.push(eq(t.movies.tmdbId, query.tmdbId));
  if (query.search) where.push(like(t.movies.cleanTitle, `%${toCleanTitle(query.search)}%`));

  const column = movieSortColumns[query.sortKey];
  const rows = db
    .select()
    .from(t.movies)
    .where(where.length ? and(...where) : undefined)
    .orderBy(query.sortOrder === 'desc' ? desc(column) : asc(column), asc(t.movies.id))
    .all()
    .filter((r) => query.tag === undefined || r.tags.includes(query.tag));
  if (rows.length === 0) return [];

  const files = groupBy(
    db
      .select()
      .from(t.mediaFiles)
      .where(inArray(t.mediaFiles.movieId, rows.map((r) => r.id)))
      .all(),
    (f) => f.movieId ?? -1,
  );
  return rows.map((r) => toMovie(r, files.get(r.id) ?? [], now));
}

export function updateMovie(db: Db, id: number, req: UpdateMovieRequest, now: string = nowIso()): Movie {
  return db.transaction((tx) => {
    const current = tx.select().from(t.movies).where(eq(t.movies.id, id)).get();
    if (!current) throw LibraryError.notFound('movie', id);

    const patch: Partial<typeof t.movies.$inferInsert> = {};
    if (req.monitored !== undefined) patch.monitored = req.monitored;
    if (req.qualityProfileId !== undefined) patch.qualityProfileId = req.qualityProfileId;
    if (req.minimumAvailability !== undefined) patch.minimumAvailability = req.minimumAvailability;
    if (req.languageProfileId !== undefined) patch.languageProfileId = req.languageProfileId;
    if (req.tags !== undefined) patch.tags = requireTags(tx, req.tags);
    if (req.rootFolderPath !== undefined) {
      patch.rootFolderPath = requireRootFolder(tx, req.rootFolderPath, 'movie');
      patch.path = req.path ?? buildMediaPath(patch.rootFolderPath, current.title, current.year);
    } else if (req.path !== undefined) {
      patch.path = req.path;
    }
    if (patch.path && patch.path !== current.path) {
      const clash = tx.select({ id: t.movies.id }).from(t.movies).where(eq(t.movies.path, patch.path)).get();
      if (clash) throw new LibraryError('CONFLICT', `a movie already uses the path ${patch.path}`);
    }
    if (Object.keys(patch).length > 0) tx.update(t.movies).set(patch).where(eq(t.movies.id, id)).run();
    return getMovie(tx, id, now);
  });
}

export function bulkUpdateMovies(db: Db, req: BulkMovieUpdateRequest, now: string = nowIso()): Movie[] {
  return db.transaction((tx) => {
    const rows = tx.select().from(t.movies).where(inArray(t.movies.id, req.ids)).all();
    const found = new Set(rows.map((r) => r.id));
    const missing = req.ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw LibraryError.notFound('movie', missing.join(', '));

    const rootFolderPath = req.rootFolderPath !== undefined ? requireRootFolder(tx, req.rootFolderPath, 'movie') : undefined;
    if (req.tags) requireTags(tx, [...(req.tags.add ?? []), ...(req.tags.remove ?? [])]);

    for (const row of rows) {
      const patch: Partial<typeof t.movies.$inferInsert> = {};
      if (req.monitored !== undefined) patch.monitored = req.monitored;
      if (req.qualityProfileId !== undefined) patch.qualityProfileId = req.qualityProfileId;
      if (req.minimumAvailability !== undefined) patch.minimumAvailability = req.minimumAvailability;
      if (rootFolderPath !== undefined) {
        patch.rootFolderPath = rootFolderPath;
        patch.path = buildMediaPath(rootFolderPath, row.title, row.year);
      }
      if (req.tags) patch.tags = applyTagChange(row.tags, req.tags);
      if (Object.keys(patch).length > 0) tx.update(t.movies).set(patch).where(eq(t.movies.id, row.id)).run();
    }
    return req.ids.map((id) => getMovie(tx, id, now));
  });
}

export function refreshMovieMetadata(db: LibraryDb, id: number, meta: MovieMetadataInput, now: string = nowIso()): Movie {
  const current = db.select({ id: t.movies.id }).from(t.movies).where(eq(t.movies.id, id)).get();
  if (!current) throw LibraryError.notFound('movie', id);
  const { tmdbId: _tmdbId, ...columns } = movieMetadataColumns(meta);
  db.update(t.movies).set({ ...columns, lastRefreshed: now }).where(eq(t.movies.id, id)).run();
  return getMovie(db, id, now);
}

export async function deleteMovie(db: Db, id: number, opts: DeleteMediaOptions = {}): Promise<void> {
  const row = db.select().from(t.movies).where(eq(t.movies.id, id)).get();
  if (!row) throw LibraryError.notFound('movie', id);
  db.transaction((tx) => {
    if (opts.addExclusion) {
      tx.insert(t.importExclusions)
        .values({ mediaType: 'movie', tmdbId: row.tmdbId, title: row.title, year: row.year })
        .onConflictDoNothing()
        .run();
    }
    tx.delete(t.movies).where(eq(t.movies.id, id)).run();
  });
  if (opts.deleteFiles) await removeMediaFolder(row.path, row.rootFolderPath);
}

export function listImportExclusions(db: LibraryDb): ImportExclusion[] {
  return db.select().from(t.importExclusions).orderBy(asc(t.importExclusions.title)).all();
}

export function isExcluded(db: LibraryDb, mediaType: 'series' | 'movie', tmdbId: number): boolean {
  return !!db
    .select({ id: t.importExclusions.id })
    .from(t.importExclusions)
    .where(and(eq(t.importExclusions.mediaType, mediaType), eq(t.importExclusions.tmdbId, tmdbId)))
    .get();
}

export function deleteImportExclusion(db: LibraryDb, id: number): void {
  const row = db.delete(t.importExclusions).where(eq(t.importExclusions.id, id)).returning().get();
  if (!row) throw LibraryError.notFound('import exclusion', id);
}

// ---------------------------------------------------------------------------------------
// Media files
// ---------------------------------------------------------------------------------------

function toMediaFile(row: MediaFileRow, episodeIds: number[]): MediaFile {
  return { ...row, episodeIds };
}

function episodeIdsForFiles(db: LibraryDb, fileIds: number[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  if (fileIds.length === 0) return map;
  const rows = db
    .select({ id: t.episodes.id, fileId: t.episodes.episodeFileId })
    .from(t.episodes)
    .where(inArray(t.episodes.episodeFileId, fileIds))
    .orderBy(asc(t.episodes.seasonNumber), asc(t.episodes.episodeNumber))
    .all();
  for (const r of rows) {
    if (r.fileId === null) continue;
    const bucket = map.get(r.fileId);
    if (bucket) bucket.push(r.id);
    else map.set(r.fileId, [r.id]);
  }
  return map;
}

export function listMediaFiles(db: LibraryDb, query: MediaFileListQuery): MediaFile[] {
  const where: SQL[] = [];
  if (query.seriesId !== undefined) where.push(eq(t.mediaFiles.seriesId, query.seriesId));
  if (query.movieId !== undefined) where.push(eq(t.mediaFiles.movieId, query.movieId));
  if (query.seasonNumber !== undefined) where.push(eq(t.mediaFiles.seasonNumber, query.seasonNumber));
  const rows = db
    .select()
    .from(t.mediaFiles)
    .where(and(...where))
    .orderBy(asc(t.mediaFiles.relativePath))
    .all();
  const links = episodeIdsForFiles(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toMediaFile(r, links.get(r.id) ?? []));
}

export function getMediaFile(db: LibraryDb, id: number): MediaFile {
  const row = db.select().from(t.mediaFiles).where(eq(t.mediaFiles.id, id)).get();
  if (!row) throw LibraryError.notFound('media file', id);
  return toMediaFile(row, episodeIdsForFiles(db, [id]).get(id) ?? []);
}

/**
 * Record an imported file and link it to its episodes or movie. Any file those episodes (or
 * that movie) previously pointed at is unlinked; when nothing references it any more the row
 * is deleted (the caller, the import pipeline, is responsible for the bytes on disk). Returns
 * the new file and the ids of file rows it replaced.
 */
export function addMediaFile(db: Db, input: AddMediaFileInput, now: string = nowIso()): { file: MediaFile; replacedFileIds: number[] } {
  return db.transaction((tx) => {
    if (input.mediaType === 'series') {
      if (input.seriesId === undefined || !input.episodeIds?.length) {
        throw new LibraryError('VALIDATION', 'series media files need seriesId and at least one episodeId');
      }
      if (!tx.select({ id: t.series.id }).from(t.series).where(eq(t.series.id, input.seriesId)).get()) {
        throw LibraryError.notFound('series', input.seriesId);
      }
    } else if (input.movieId === undefined) {
      throw new LibraryError('VALIDATION', 'movie media files need movieId');
    } else if (!tx.select({ id: t.movies.id }).from(t.movies).where(eq(t.movies.id, input.movieId)).get()) {
      throw LibraryError.notFound('movie', input.movieId);
    }
    if (tx.select({ id: t.mediaFiles.id }).from(t.mediaFiles).where(eq(t.mediaFiles.path, input.path)).get()) {
      throw new LibraryError('CONFLICT', `a media file already exists at ${input.path}`);
    }

    const row = tx
      .insert(t.mediaFiles)
      .values({
        mediaType: input.mediaType,
        seriesId: input.seriesId ?? null,
        movieId: input.movieId ?? null,
        seasonNumber: input.seasonNumber ?? null,
        relativePath: input.relativePath,
        path: input.path,
        sizeBytes: input.sizeBytes,
        dateAdded: input.dateAdded ?? now,
        quality: input.quality,
        languages: input.languages,
        releaseGroup: input.releaseGroup ?? null,
        sceneName: input.sceneName ?? null,
        edition: input.edition ?? null,
        mediaInfo: input.mediaInfo ?? null,
      })
      .returning()
      .get();

    const replaced = new Set<number>();
    if (input.mediaType === 'series' && input.episodeIds) {
      const episodeRows = tx.select().from(t.episodes).where(inArray(t.episodes.id, input.episodeIds)).all();
      if (episodeRows.length !== new Set(input.episodeIds).size) {
        throw new LibraryError('VALIDATION', 'one or more episodeIds do not exist');
      }
      if (episodeRows.some((e) => e.seriesId !== input.seriesId)) {
        throw new LibraryError('VALIDATION', 'episodes must belong to the file\'s series');
      }
      for (const e of episodeRows) if (e.episodeFileId !== null) replaced.add(e.episodeFileId);
      tx.update(t.episodes)
        .set({ hasFile: true, episodeFileId: row.id })
        .where(inArray(t.episodes.id, input.episodeIds))
        .run();
    } else if (input.movieId !== undefined) {
      const movie = tx.select().from(t.movies).where(eq(t.movies.id, input.movieId)).get();
      if (movie?.movieFileId) replaced.add(movie.movieFileId);
      tx.update(t.movies).set({ hasFile: true, movieFileId: row.id }).where(eq(t.movies.id, input.movieId)).run();
    }

    const replacedFileIds: number[] = [];
    for (const oldId of replaced) {
      const stillLinked = tx.select({ id: t.episodes.id }).from(t.episodes).where(eq(t.episodes.episodeFileId, oldId)).get();
      if (!stillLinked) {
        tx.delete(t.mediaFiles).where(eq(t.mediaFiles.id, oldId)).run();
        replacedFileIds.push(oldId);
      }
    }
    return { file: getMediaFile(tx, row.id), replacedFileIds };
  });
}

export async function deleteMediaFile(db: Db, id: number, opts: { deleteFromDisk?: boolean } = {}): Promise<void> {
  const row = db.select().from(t.mediaFiles).where(eq(t.mediaFiles.id, id)).get();
  if (!row) throw LibraryError.notFound('media file', id);
  db.transaction((tx) => {
    tx.update(t.episodes).set({ hasFile: false, episodeFileId: null }).where(eq(t.episodes.episodeFileId, id)).run();
    tx.update(t.movies).set({ hasFile: false, movieFileId: null }).where(eq(t.movies.movieFileId, id)).run();
    tx.delete(t.mediaFiles).where(eq(t.mediaFiles.id, id)).run();
  });
  if (opts.deleteFromDisk) await rm(row.path, { force: true });
}

// ---------------------------------------------------------------------------------------
// Wanted
// ---------------------------------------------------------------------------------------

interface Page<T> {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: T[];
}

function paginate<T>(items: T[], q: PageQuery): Page<T> {
  const start = (q.page - 1) * q.pageSize;
  return { page: q.page, pageSize: q.pageSize, totalRecords: items.length, records: items.slice(start, start + q.pageSize) };
}

function monitoredEpisodesWithSeries(db: LibraryDb, hasFile: boolean, includeSpecials: boolean) {
  const where: SQL[] = [
    eq(t.episodes.monitored, true),
    eq(t.episodes.hasFile, hasFile),
    eq(t.series.monitored, true),
  ];
  return db
    .select({ episode: t.episodes, series: t.series })
    .from(t.episodes)
    .innerJoin(t.series, eq(t.episodes.seriesId, t.series.id))
    .where(and(...where))
    .orderBy(desc(t.episodes.airDateUtc), asc(t.episodes.seriesId), asc(t.episodes.seasonNumber), asc(t.episodes.episodeNumber))
    .all()
    .filter((r) => includeSpecials || r.episode.seasonNumber > 0);
}

function toWanted(r: { episode: EpisodeRow; series: SeriesRow }): WantedEpisode {
  return {
    ...toEpisode(r.episode),
    seriesTitle: r.series.title,
    seriesTmdbId: r.series.tmdbId,
    qualityProfileId: r.series.qualityProfileId,
  };
}

/** Monitored episodes of monitored series that have aired and have no file. */
export function listMissingEpisodes(db: LibraryDb, q: WantedEpisodesQuery, now: string = nowIso()): Page<WantedEpisode> {
  const nowMs = Date.parse(now);
  const rows = monitoredEpisodesWithSeries(db, false, q.includeSpecials).filter((r) => {
    if (!r.episode.airDateUtc) return false;
    return Date.parse(r.episode.airDateUtc) <= nowMs;
  });
  return paginate(rows.map(toWanted), q);
}

/**
 * Monitored episodes whose file does not meet the profile cutoff. The cutoff decision belongs
 * to the profiles module; it is injected so this module stays ignorant of profile shapes.
 */
export function listCutoffUnmetEpisodes(db: LibraryDb, q: WantedEpisodesQuery, isCutoffMet: IsCutoffMet): Page<WantedEpisode> {
  const rows = monitoredEpisodesWithSeries(db, true, q.includeSpecials);
  const fileIds = [...new Set(rows.map((r) => r.episode.episodeFileId).filter((id): id is number => id !== null))];
  const files = new Map<number, MediaFile>();
  if (fileIds.length > 0) {
    const links = episodeIdsForFiles(db, fileIds);
    for (const f of db.select().from(t.mediaFiles).where(inArray(t.mediaFiles.id, fileIds)).all()) {
      files.set(f.id, toMediaFile(f, links.get(f.id) ?? []));
    }
  }
  const unmet = rows.filter((r) => {
    const file = r.episode.episodeFileId !== null ? files.get(r.episode.episodeFileId) : undefined;
    return file !== undefined && !isCutoffMet(file);
  });
  return paginate(unmet.map(toWanted), q);
}

/** Monitored movies without a file that are available under their minimum availability. */
export function listMissingMovies(db: LibraryDb, q: PageQuery, now: string = nowIso()): Page<Movie> {
  const rows = db
    .select()
    .from(t.movies)
    .where(and(eq(t.movies.monitored, true), eq(t.movies.hasFile, false)))
    .orderBy(asc(t.movies.sortTitle))
    .all()
    .filter((m) => isMovieAvailable(m, now));
  return paginate(
    rows.map((m) => toMovie(m, [], now)),
    q,
  );
}

export function listCutoffUnmetMovies(db: LibraryDb, q: PageQuery, isCutoffMet: IsCutoffMet, now: string = nowIso()): Page<Movie> {
  const rows = db
    .select()
    .from(t.movies)
    .where(and(eq(t.movies.monitored, true), eq(t.movies.hasFile, true)))
    .orderBy(asc(t.movies.sortTitle))
    .all();
  const ids = rows.map((m) => m.id);
  const files = ids.length ? groupBy(db.select().from(t.mediaFiles).where(inArray(t.mediaFiles.movieId, ids)).all(), (f) => f.movieId ?? -1) : new Map<number, MediaFileRow[]>();
  const unmet = rows.filter((m) => {
    const file = (files.get(m.id) ?? []).find((f) => f.id === m.movieFileId);
    return file !== undefined && !isCutoffMet(toMediaFile(file, []));
  });
  return paginate(
    unmet.map((m) => toMovie(m, files.get(m.id) ?? [], now)),
    q,
  );
}

// ---------------------------------------------------------------------------------------
// Library-wide statistics
// ---------------------------------------------------------------------------------------

export async function getLibraryStatistics(db: LibraryDb, now: string = nowIso()): Promise<LibraryStatistics> {
  const seriesRows = db.select({ monitored: t.series.monitored, status: t.series.status }).from(t.series).all();
  const episodeRows = db
    .select({ seasonNumber: t.episodes.seasonNumber, monitored: t.episodes.monitored, hasFile: t.episodes.hasFile, airDateUtc: t.episodes.airDateUtc })
    .from(t.episodes)
    .all();
  const movieRows = db.select({ monitored: t.movies.monitored, hasFile: t.movies.hasFile }).from(t.movies).all();
  const fileRows = db.select({ mediaType: t.mediaFiles.mediaType, sizeBytes: t.mediaFiles.sizeBytes }).from(t.mediaFiles).all();
  const episodeStats = computeSeasonStatistics(
    episodeRows,
    fileRows.filter((f) => f.mediaType === 'series').map((f) => ({ seasonNumber: null, sizeBytes: f.sizeBytes })),
    now,
  );
  return {
    seriesCount: seriesRows.length,
    monitoredSeriesCount: seriesRows.filter((s) => s.monitored).length,
    endedSeriesCount: seriesRows.filter((s) => s.status === 'ended').length,
    continuingSeriesCount: seriesRows.filter((s) => s.status === 'continuing' || s.status === 'upcoming').length,
    episodeCount: episodeStats.episodeCount,
    episodeFileCount: episodeStats.episodeFileCount,
    movieCount: movieRows.length,
    monitoredMovieCount: movieRows.filter((m) => m.monitored).length,
    movieFileCount: movieRows.filter((m) => m.hasFile).length,
    sizeOnDisk: fileRows.reduce((sum, f) => sum + f.sizeBytes, 0),
    rootFolders: await listRootFolders(db),
  };
}

