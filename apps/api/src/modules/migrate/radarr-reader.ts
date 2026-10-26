import type { MigratePathMapping, MovieStatus } from '@media-tron/shared';
import { arrSchemaVersion, readArrInfrastructure, remappedRootFolders, rootFolderFor, warn, type ReaderContext } from './arr-common.js';
import { MigrateError } from './errors.js';
import { bool, dayOnly, ForeignDb, idList, int, isoDate, json, str, type ForeignRow } from './foreign-db.js';
import { mapMinimumAvailability } from './mappers/import-lists.js';
import { mapLanguageId, mapLanguageList } from './mappers/languages.js';
import { mapGenres, mapImages, mapMediaInfo, mapRatings } from './mappers/media.js';
import { mapQualityModel } from './mappers/quality.js';
import { joinPath, remapPath } from './paths.js';
import type { FilePayload, MoviePayload, SourceBundle, SourceItem } from './types.js';

// Radarr. Since v4 the TMDB metadata lives in MovieMetadata (joined by MovieMetadataId);
// older schemas keep it on the Movies row, so each field is read from the metadata row
// first and the movie row second.

const MOVIE_STATUS: Record<number, MovieStatus> = { 0: 'tba', 1: 'announced', 2: 'inCinemas', 3: 'released', [-1]: 'deleted' };

function movieStatus(v: unknown): MovieStatus {
  if (typeof v === 'string' && Number.isNaN(Number(v))) {
    const s = v.toLowerCase();
    return s === 'announced' ? 'announced' : s === 'incinemas' ? 'inCinemas' : s === 'released' ? 'released' : s === 'deleted' ? 'deleted' : 'tba';
  }
  return MOVIE_STATUS[int(v) ?? 0] ?? 'tba';
}

function readMovieFile(ctx: ReaderContext, row: ForeignRow, moviePath: string): FilePayload | null {
  const relative = str(row['relativepath']);
  const legacy = str(row['path']);
  if (!relative && !legacy) return null;
  const path = relative ? joinPath(moviePath, relative) : remapPath(legacy!, ctx.mappings).path;
  return {
    sourceId: String(int(row['id'])),
    seasonNumber: null,
    relativePath: relative ?? path.slice(moviePath.length).replace(/^[\\/]+/, ''),
    path,
    sizeBytes: Math.max(0, int(row['size']) ?? 0),
    dateAdded: isoDate(row['dateadded']),
    quality: mapQualityModel('radarr', json<unknown>(row['quality'], {})),
    languages: mapLanguageList('radarr', json<unknown>(row['languages'], [])),
    releaseGroup: str(row['releasegroup']),
    sceneName: str(row['scenename']),
    edition: str(row['edition']) || null,
    mediaInfo: mapMediaInfo(row['mediainfo']),
  };
}

export function readRadarrMovies(ctx: ReaderContext): SourceItem<MoviePayload>[] {
  const roots = remappedRootFolders(ctx);
  const metadata = new Map<number, ForeignRow>();
  for (const m of ctx.db.rows('MovieMetadata')) {
    const mid = int(m['id']);
    if (mid !== null) metadata.set(mid, m);
  }
  const files = new Map<number, ForeignRow>();
  const filesByMovie = new Map<number, ForeignRow>();
  for (const f of ctx.db.rows('MovieFiles')) {
    const fid = int(f['id']);
    if (fid !== null) files.set(fid, f);
    const mid = int(f['movieid']);
    if (mid !== null) filesByMovie.set(mid, f);
  }

  const items: SourceItem<MoviePayload>[] = [];
  for (const r of ctx.db.rows('Movies')) {
    const sourceId = String(int(r['id']));
    const meta = metadata.get(int(r['moviemetadataid']) ?? -1) ?? {};
    const pick = (key: string) => (meta[key] !== undefined && meta[key] !== null ? meta[key] : r[key]);
    const title = str(pick('title')) ?? `Movie ${sourceId}`;
    const year = int(pick('year')) ?? 0;
    const rawPath = str(r['path']) ?? '';
    const path = remapPath(rawPath, ctx.mappings).path.replace(/[\\/]+$/, '');
    const { root, matched } = rootFolderFor(path, roots);
    if (!matched && path) warn(ctx, 'movies', `"${title}": ${path} is not under a root folder; using ${root}`, sourceId);

    const fileRow = files.get(int(r['moviefileid']) ?? -1) ?? filesByMovie.get(int(r['id']) ?? -1) ?? null;
    const file = fileRow ? readMovieFile(ctx, fileRow, path) : null;
    const tmdbId = int(pick('tmdbid'));
    const lang = int(pick('originallanguage'));
    const collectionTmdbId = int(pick('collectiontmdbid'));
    const collectionTitle = str(pick('collectiontitle'));
    const runtime = int(pick('runtime'));
    const item: SourceItem<MoviePayload> = {
      sourceId,
      name: year ? `${title} (${year})` : title,
      payload: {
        tmdbId: tmdbId && tmdbId > 0 ? tmdbId : null,
        imdbId: str(pick('imdbid')) || null,
        title,
        originalTitle: str(pick('originaltitle')) ?? title,
        year,
        overview: str(pick('overview')) ?? '',
        status: movieStatus(pick('status')),
        inCinemas: dayOnly(pick('incinemas')),
        digitalRelease: dayOnly(pick('digitalrelease')),
        physicalRelease: dayOnly(pick('physicalrelease')),
        runtimeMinutes: runtime && runtime > 0 ? runtime : null,
        studio: str(pick('studio')),
        genres: mapGenres(pick('genres')),
        images: mapImages(pick('images')),
        ratings: mapRatings(pick('ratings'), 'tmdb'),
        certification: str(pick('certification')),
        originalLanguage: (lang !== null ? mapLanguageId('radarr', lang) : undefined) ?? 'en',
        collection: collectionTmdbId && collectionTitle ? { tmdbId: collectionTmdbId, title: collectionTitle } : null,
        path,
        rootFolderPath: root,
        sourceQualityProfileId: int(r['qualityprofileid'] ?? r['profileid']),
        minimumAvailability: mapMinimumAvailability(r['minimumavailability']),
        monitored: bool(r['monitored'], true),
        sourceTagIds: idList(r['tags']),
        added: isoDate(r['added']),
        file,
      },
    };
    if (!item.payload.tmdbId) item.unsupported = 'no TMDB id';
    else if (!path) item.unsupported = 'movie has no path';
    items.push(item);
  }
  return items;
}

export function readRadarrCollections(ctx: ReaderContext): SourceItem<unknown>[] {
  return ctx.db.rows('Collections').map((r) => {
    const title = str(r['title']) ?? `Collection ${String(int(r['id']))}`;
    const rootRaw = str(r['rootfolderpath']);
    return {
      sourceId: String(int(r['id'])),
      name: title,
      stageArea: 'library.collections' as const,
      payload: {
        tmdbId: int(r['tmdbid']),
        title,
        monitored: bool(r['monitored']),
        sourceQualityProfileId: int(r['qualityprofileid']),
        rootFolderPath: rootRaw ? remapPath(rootRaw, ctx.mappings).path : null,
        searchOnAdd: bool(r['searchonadd']),
        minimumAvailability: mapMinimumAvailability(r['minimumavailability']),
        sourceTagIds: idList(r['tags']),
      },
    };
  });
}

export function readRadarr(dbPath: string, mappings: readonly MigratePathMapping[]): SourceBundle {
  const db = ForeignDb.open(dbPath);
  try {
    if (!db.hasTable('Movies')) throw new MigrateError('WRONG_APP', `${dbPath} does not look like a Radarr database (no Movies table)`);
    const ctx: ReaderContext = { db, app: 'radarr', mappings, warnings: [] };
    const movies = readRadarrMovies(ctx);
    const collections = readRadarrCollections(ctx);
    return {
      app: 'radarr',
      schemaVersion: arrSchemaVersion(db),
      warnings: ctx.warnings,
      areas: {
        ...readArrInfrastructure(ctx, 'movie'),
        movies: { mode: 'import', items: movies, details: { files: movies.filter((m) => m.payload.file).length } },
        ...(collections.length > 0 ? { collections: { mode: 'stage' as const, items: collections } } : {}),
      },
    };
  } finally {
    db.close();
  }
}
