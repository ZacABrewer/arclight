import type { MigratePathMapping, SeriesStatus } from '@arclight/shared';
import { arrSchemaVersion, readArrInfrastructure, remappedRootFolders, rootFolderFor, warn, type ReaderContext } from './arr-common.js';
import { bool, dayOnly, ForeignDb, idList, int, isoDate, json, jsonArray, str, type ForeignRow } from './foreign-db.js';
import { mapLanguageId, mapLanguageList } from './mappers/languages.js';
import { mapGenres, mapImages, mapMediaInfo, mapRatings } from './mappers/media.js';
import { mapQualityModel } from './mappers/quality.js';
import { mapSeriesType } from './mappers/import-lists.js';
import { joinPath, remapPath } from './paths.js';
import type { EpisodePayload, FilePayload, SeriesPayload, SourceBundle, SourceItem } from './types.js';
import { MigrateError } from './errors.js';

// Sonarr (v3 and v4 schemas). Series rows carry the library settings; episodes and episode
// files hang off them. Everything is read once and grouped in memory.

const SERIES_STATUS: Record<number, SeriesStatus> = { 0: 'continuing', 1: 'ended', 2: 'upcoming', [-1]: 'deleted' };

function seriesStatus(v: unknown): SeriesStatus {
  if (typeof v === 'string' && Number.isNaN(Number(v))) {
    const s = v.toLowerCase();
    return s === 'ended' ? 'ended' : s === 'upcoming' ? 'upcoming' : s === 'deleted' ? 'deleted' : 'continuing';
  }
  return SERIES_STATUS[int(v) ?? 0] ?? 'continuing';
}

export function readSonarrFile(ctx: ReaderContext, row: ForeignRow, seriesPath: string): FilePayload | null {
  const relative = str(row['relativepath']);
  const legacyPath = str(row['path']);
  if (!relative && !legacyPath) return null;
  const path = relative ? joinPath(seriesPath, relative) : remapPath(legacyPath!, ctx.mappings).path;
  const languages = row['languages'] !== undefined ? mapLanguageList('sonarr', json<unknown>(row['languages'], [])) : mapLanguageList('sonarr', json<unknown>(row['language'], null));
  return {
    sourceId: String(int(row['id'])),
    seasonNumber: int(row['seasonnumber']),
    relativePath: relative ?? path.slice(seriesPath.length).replace(/^[\\/]+/, ''),
    path,
    sizeBytes: Math.max(0, int(row['size']) ?? 0),
    dateAdded: isoDate(row['dateadded']),
    quality: mapQualityModel('sonarr', json<unknown>(row['quality'], {})),
    languages,
    releaseGroup: str(row['releasegroup']),
    sceneName: str(row['scenename']),
    edition: null,
    mediaInfo: mapMediaInfo(row['mediainfo']),
  };
}

export function readSonarrSeries(ctx: ReaderContext): SourceItem<SeriesPayload>[] {
  const roots = remappedRootFolders(ctx);
  const episodesBySeries = new Map<number, ForeignRow[]>();
  for (const e of ctx.db.rows('Episodes')) {
    const sid = int(e['seriesid']);
    if (sid === null) continue;
    const bucket = episodesBySeries.get(sid);
    if (bucket) bucket.push(e);
    else episodesBySeries.set(sid, [e]);
  }
  const filesBySeries = new Map<number, ForeignRow[]>();
  for (const f of ctx.db.rows('EpisodeFiles')) {
    const sid = int(f['seriesid']);
    if (sid === null) continue;
    const bucket = filesBySeries.get(sid);
    if (bucket) bucket.push(f);
    else filesBySeries.set(sid, [f]);
  }

  const items: SourceItem<SeriesPayload>[] = [];
  for (const r of ctx.db.rows('Series')) {
    const sourceId = String(int(r['id']));
    const title = str(r['title']) ?? `Series ${sourceId}`;
    const rawPath = str(r['path']) ?? '';
    const remapped = remapPath(rawPath, ctx.mappings);
    const path = remapped.path.replace(/[\\/]+$/, '');
    const { root, matched } = rootFolderFor(path, roots);
    if (!matched && path) warn(ctx, 'series', `"${title}": ${path} is not under a root folder; using ${root}`, sourceId);

    const files = (filesBySeries.get(int(r['id']) ?? -1) ?? []).map((f) => readSonarrFile(ctx, f, path)).filter((f): f is FilePayload => f !== null);
    const fileIds = new Set(files.map((f) => f.sourceId));
    const episodes: EpisodePayload[] = (episodesBySeries.get(int(r['id']) ?? -1) ?? []).flatMap((e) => {
      const seasonNumber = int(e['seasonnumber']);
      const episodeNumber = int(e['episodenumber']);
      if (seasonNumber === null || episodeNumber === null) return [];
      const fileId = int(e['episodefileid']);
      const runtime = int(e['runtime']);
      return [
        {
          sourceId: String(int(e['id'])),
          seasonNumber,
          episodeNumber,
          absoluteEpisodeNumber: int(e['absoluteepisodenumber']),
          title: str(e['title']),
          overview: str(e['overview']),
          airDate: dayOnly(e['airdate']),
          airDateUtc: isoDate(e['airdateutc']),
          runtimeMinutes: runtime && runtime > 0 ? runtime : null,
          monitored: bool(e['monitored'], true),
          sourceFileId: fileId && fileIds.has(String(fileId)) ? String(fileId) : null,
        },
      ];
    });

    const seasons = jsonArray(r['seasons']).flatMap((s) => {
      if (!s || typeof s !== 'object') return [];
      const o = s as Record<string, unknown>;
      const n = int(o['seasonNumber'] ?? o['SeasonNumber']);
      return n === null ? [] : [{ seasonNumber: n, monitored: bool(o['monitored'] ?? o['Monitored'], true) }];
    });

    const tmdbId = int(r['tmdbid']);
    const originalLanguage = int(r['originallanguage']);
    const runtime = int(r['runtime']);
    const firstAired = dayOnly(r['firstaired']);
    const year = int(r['year']) || (firstAired ? Number(firstAired.slice(0, 4)) : 0);
    const item: SourceItem<SeriesPayload> = {
      sourceId,
      name: year ? `${title} (${year})` : title,
      payload: {
        tmdbId: tmdbId && tmdbId > 0 ? tmdbId : null,
        tvdbId: int(r['tvdbid']) || null,
        imdbId: str(r['imdbid']) || null,
        title,
        year,
        overview: str(r['overview']) ?? '',
        status: seriesStatus(r['status']),
        network: str(r['network']),
        runtimeMinutes: runtime && runtime > 0 ? runtime : null,
        genres: mapGenres(r['genres']),
        images: mapImages(r['images']),
        ratings: mapRatings(r['ratings'], 'tvdb'),
        certification: str(r['certification']),
        originalLanguage: (originalLanguage !== null ? mapLanguageId('sonarr', originalLanguage) : undefined) ?? 'en',
        path,
        rootFolderPath: root,
        sourceQualityProfileId: int(r['qualityprofileid'] ?? r['profileid']),
        monitored: bool(r['monitored'], true),
        monitorNewItems: int(r['monitornewitems']) === 1 ? 'none' : 'all',
        seriesType: mapSeriesType(r['seriestype']),
        seasonFolder: bool(r['seasonfolder'], true),
        useSceneNumbering: bool(r['usescenenumbering']),
        sourceTagIds: idList(r['tags']),
        added: isoDate(r['added']),
        seasons,
        episodes,
        files,
      },
    };
    if (!item.payload.tmdbId) item.unsupported = 'no TMDB id (Sonarr v3 or never refreshed); add it from Library → Add New';
    else if (!path) item.unsupported = 'series has no path';
    items.push(item);
  }
  return items;
}

export function readSonarr(dbPath: string, mappings: readonly MigratePathMapping[]): SourceBundle {
  const db = ForeignDb.open(dbPath);
  try {
    if (!db.hasTable('Series') || !db.hasTable('Episodes')) {
      throw new MigrateError('WRONG_APP', `${dbPath} does not look like a Sonarr database (no Series/Episodes tables)`);
    }
    const ctx: ReaderContext = { db, app: 'sonarr', mappings, warnings: [] };
    const series = readSonarrSeries(ctx);
    const episodes = series.reduce((n, s) => n + s.payload.episodes.length, 0);
    const files = series.reduce((n, s) => n + s.payload.files.length, 0);
    if (db.hasTable('LanguageProfiles')) {
      warn(ctx, 'qualityProfiles', 'Sonarr v3 language profiles are not imported; Arclight filters languages per quality profile');
    }
    return {
      app: 'sonarr',
      schemaVersion: arrSchemaVersion(db),
      warnings: ctx.warnings,
      areas: {
        ...readArrInfrastructure(ctx, 'series'),
        series: { mode: 'import', items: series, details: { episodes, files } },
      },
    };
  } finally {
    db.close();
  }
}
