import type { ImportListImplementation, MinimumAvailability, MonitorOption, SeriesType } from '@arclight/shared';
import { bool, field, int, str, type ForeignRow } from '../foreign-db.js';
import type { ArrApp } from './quality.js';

// Import lists (TMDB / Trakt / Plex / IMDb / RSS). Trakt lists are bound to the upstream
// app's OAuth client, so they cannot be carried over and must be re-authorised.

export interface ImportListMapResult {
  implementation: ImportListImplementation | null;
  settings: Record<string, unknown>;
  unsupported?: string;
  notes: string[];
}

export function mapImportListSettings(upstream: string, s: Record<string, unknown>): ImportListMapResult {
  const impl = upstream.toLowerCase();
  const g = (...names: string[]) => field(s, ...names);
  const notes: string[] = [];
  const id = (v: unknown) => {
    const n = int(v);
    return n !== null && n > 0 ? n : null;
  };
  switch (impl) {
    case 'tmdblistimport':
      return { implementation: 'tmdbList', settings: { listId: str(g('listId')) ?? '' }, notes };
    case 'tmdbpopularimport': {
      const t = int(g('tmdbListType', 'listType'));
      if (t !== 2 && t !== 3) notes.push('TMDB "in theaters"/"upcoming" lists become "popular"');
      return { implementation: 'tmdbPopular', settings: { listType: t === 3 ? 'topRated' : 'popular' }, notes };
    }
    case 'tmdbcollectionimport': {
      const collectionId = id(g('collectionId'));
      if (collectionId === null) return { implementation: null, settings: {}, unsupported: 'TMDB collection id missing', notes };
      return { implementation: 'tmdbCollection', settings: { collectionId }, notes };
    }
    case 'tmdbpersonimport': {
      const personId = id(g('personId'));
      if (personId === null) return { implementation: null, settings: {}, unsupported: 'TMDB person id missing', notes };
      const jobs: string[] = [];
      if (bool(g('personCastDirector'))) jobs.push('Director');
      if (bool(g('personCastProducer'))) jobs.push('Producer');
      if (bool(g('personCastSound'))) jobs.push('Sound');
      if (bool(g('personCastWriting'))) jobs.push('Writer');
      return { implementation: 'tmdbPerson', settings: { personId, includeCast: bool(g('personCast'), true), includeCrew: jobs.length > 0, crewJobs: jobs }, notes };
    }
    case 'tmdbkeywordimport': {
      const keywordId = id(g('keywordId'));
      if (keywordId === null) return { implementation: null, settings: {}, unsupported: 'TMDB keyword id missing', notes };
      return { implementation: 'tmdbKeyword', settings: { keywordId }, notes };
    }
    case 'imdblistimport': {
      const listId = (str(g('listId')) ?? '').trim();
      if (!/^(ls|ur)\d+$/.test(listId)) return { implementation: null, settings: {}, unsupported: `IMDb list id "${listId}" is not an ls/ur id`, notes };
      return { implementation: 'imdbList', settings: { listId }, notes };
    }
    case 'pleximport': {
      const plexToken = str(g('accessToken', 'plexToken'));
      if (!plexToken) return { implementation: null, settings: {}, unsupported: 'Plex token missing', notes };
      return { implementation: 'plexWatchlist', settings: { plexToken }, notes };
    }
    case 'rssimport':
    case 'plexrssimport': {
      const url = str(g('link', 'url'));
      if (!url) return { implementation: null, settings: {}, unsupported: 'RSS url missing', notes };
      return { implementation: 'rss', settings: { url }, notes };
    }
    case 'stevenluimport':
    case 'stevenlu2import': {
      const url = str(g('link', 'url'));
      return { implementation: 'stevenLu', settings: url ? { url } : {}, notes };
    }
    case 'traktlistimport':
    case 'traktuserimport':
    case 'traktpopularimport':
      return { implementation: null, settings: {}, unsupported: 'Trakt lists must be re-authorised in Arclight (tokens belong to the upstream app)', notes };
    default:
      return { implementation: null, settings: {}, unsupported: `${upstream || 'unknown'} import lists are not supported`, notes };
  }
}

/** Sonarr ShouldMonitor / Monitor (enum int or name) → MonitorOption. */
export function mapMonitorOption(app: ArrApp, raw: unknown): MonitorOption {
  if (typeof raw === 'string' && Number.isNaN(Number(raw))) {
    const s = raw.toLowerCase();
    const named: Record<string, MonitorOption> = {
      all: 'all',
      future: 'future',
      missing: 'missing',
      existing: 'existing',
      firstseason: 'firstSeason',
      lastseason: 'latestSeason',
      latestseason: 'latestSeason',
      pilot: 'pilot',
      none: 'none',
      movieonly: 'all',
      movieandcollection: 'all',
    };
    return named[s] ?? 'all';
  }
  const n = int(raw);
  if (app === 'radarr') return n === 2 ? 'none' : 'all';
  switch (n) {
    case 2:
      return 'future';
    case 3:
      return 'missing';
    case 4:
      return 'existing';
    case 5:
      return 'firstSeason';
    case 6:
    case 7:
      return 'latestSeason';
    case 8:
      return 'pilot';
    case 0:
    case 12:
      return 'none';
    default:
      return 'all';
  }
}

export function mapSeriesType(raw: unknown): SeriesType {
  if (typeof raw === 'string' && Number.isNaN(Number(raw))) {
    const s = raw.toLowerCase();
    return s === 'daily' ? 'daily' : s === 'anime' ? 'anime' : 'standard';
  }
  const n = int(raw);
  return n === 1 ? 'daily' : n === 2 ? 'anime' : 'standard';
}

/** Radarr MovieStatusType-valued availability: 0 tba, 1 announced, 2 in cinemas, 3 released, 4 predb. */
export function mapMinimumAvailability(raw: unknown): MinimumAvailability {
  if (typeof raw === 'string' && Number.isNaN(Number(raw))) {
    const s = raw.toLowerCase();
    return s === 'incinemas' ? 'inCinemas' : s === 'announced' || s === 'tba' ? 'announced' : 'released';
  }
  const n = int(raw);
  if (n === 0 || n === 1) return 'announced';
  if (n === 2) return 'inCinemas';
  return 'released';
}

export interface ImportListCommon {
  enabled: boolean;
  enableAutomaticAdd: boolean;
  searchOnAdd: boolean;
  monitorOption: MonitorOption;
  seriesType: SeriesType;
  seasonFolder: boolean;
  minimumAvailability: MinimumAvailability;
  rootFolderPath: string;
  sourceQualityProfileId: number | null;
}

export function importListCommon(app: ArrApp, row: ForeignRow): ImportListCommon {
  const enableAuto = row['enableautomaticadd'] ?? row['enableauto'];
  return {
    enabled: bool(row['enabled'], true),
    enableAutomaticAdd: bool(enableAuto, true),
    searchOnAdd: bool(row['searchformissingepisodes'] ?? row['searchonadd']),
    monitorOption: mapMonitorOption(app, row['shouldmonitor'] ?? row['monitor']),
    seriesType: mapSeriesType(row['seriestype']),
    seasonFolder: bool(row['seasonfolder'], true),
    minimumAvailability: mapMinimumAvailability(row['minimumavailability']),
    rootFolderPath: str(row['rootfolderpath']) ?? '',
    sourceQualityProfileId: int(row['qualityprofileid'] ?? row['profileid']),
  };
}
