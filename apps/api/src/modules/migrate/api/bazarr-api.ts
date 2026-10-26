import type { MigrateSource, MigrationWarning } from '@arclight/shared';
import { buildBazarrBundle, parseSubtitleList, type BazarrRaw, type RawEvent } from '../bazarr-reader.js';
import type { ConfigTree } from '../config-files.js';
import { MigrateError } from '../errors.js';
import { field, int, isoDate, num, str, type ForeignRow } from '../foreign-db.js';
import type { SourceHttp } from '../http.js';
import type { ReadDeps } from '../readers.js';
import type { SourceBundle } from '../types.js';

// Bazarr read through its live API (X-API-KEY). Same normalised shape as the database reader,
// so buildBazarrBundle does the mapping for both.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** `{ data: [...] }` or a bare array. */
function list(body: unknown): Json[] {
  const arr = Array.isArray(body) ? body : isObj(body) && Array.isArray(body['data']) ? body['data'] : [];
  return arr.filter(isObj);
}

const lowerKeys = (o: Json): ForeignRow => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

/** API language: `{ code2, forced, hi }` or a plain code. */
function languageOf(v: unknown): string | null {
  if (isObj(v)) {
    const base = str(field(v, 'code2')) ?? str(field(v, 'code3'));
    if (!base) return null;
    return `${base}${v['forced'] === true ? ':forced' : v['hi'] === true ? ':hi' : ''}`;
  }
  return str(v);
}

/** Absolute timestamp from whichever field this Bazarr version fills (epoch, ISO or formatted). */
function timeOf(o: Json): string | null {
  const raw = o['raw_timestamp'];
  if (typeof raw === 'number' && raw > 0) return new Date(raw * 1000).toISOString();
  for (const k of ['raw_timestamp', 'parsed_timestamp', 'timestamp']) {
    const s = str(o[k]);
    if (!s || /ago$/i.test(s)) continue;
    const iso = isoDate(s);
    if (iso) return iso;
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/** Scores come as raw numbers or as "95.83%" (converted back to Bazarr's 360/120 scale). */
function scoreOf(v: unknown, mediaType: 'series' | 'movie'): number | null {
  if (typeof v === 'string' && v.trim().endsWith('%')) {
    const pct = num(v.trim().slice(0, -1));
    return pct === null ? null : (pct * (mediaType === 'series' ? 360 : 120)) / 100;
  }
  return num(v);
}

function event(o: Json, mediaType: 'series' | 'movie', index: number): RawEvent {
  return {
    mediaType,
    id: String(int(o['id']) ?? `${str(o['subs_id']) ?? 'x'}-${index}`),
    action: int(o['action']),
    description: str(o['description']),
    language: languageOf(o['language']),
    provider: str(o['provider']),
    score: scoreOf(o['score'], mediaType),
    subsId: str(o['subs_id']),
    sonarrSeriesId: int(o['sonarrSeriesId']),
    sonarrEpisodeId: int(o['sonarrEpisodeId']),
    radarrId: int(o['radarrId']),
    videoPath: str(o['video_path']) ?? str(o['path']),
    subtitlesPath: str(o['subtitles_path']),
    timestamp: timeOf(o),
  };
}

async function optionalList(http: SourceHttp, path: string, query: Record<string, string | number | Array<string | number>> = {}): Promise<Json[]> {
  return list(await http.optionalJson<unknown>(path, [], { query }));
}

export async function readBazarrApi(source: MigrateSource, http: SourceHttp, deps: ReadDeps): Promise<SourceBundle> {
  void deps;
  const status = await http.json<unknown>('/api/system/status');
  const version = isObj(status) && isObj(status['data']) ? str(status['data']['bazarr_version']) : null;
  if (!version) throw new MigrateError('WRONG_APP', `${http.baseUrl} does not answer like Bazarr`);
  const warnings: MigrationWarning[] = [];
  const all = { start: 0, length: -1 };

  const [profiles, settings, shows, movies, epHistory, mvHistory, epBlacklist, mvBlacklist] = await Promise.all([
    optionalList(http, '/api/system/languages/profiles'),
    http.optionalJson<unknown>('/api/system/settings', null),
    optionalList(http, '/api/series', all),
    optionalList(http, '/api/movies', all),
    optionalList(http, '/api/episodes/history', all),
    optionalList(http, '/api/movies/history', all),
    optionalList(http, '/api/episodes/blacklist', all),
    optionalList(http, '/api/movies/blacklist', all),
  ]);

  const seriesIds = shows.map((s) => int(s['sonarrSeriesId'])).filter((x): x is number => x !== null);
  const episodes: Json[] = [];
  for (let i = 0; i < seriesIds.length; i += 50) {
    const chunk = seriesIds.slice(i, i + 50);
    episodes.push(...(await optionalList(http, '/api/episodes', { 'seriesid[]': chunk })));
  }

  const history = [...epHistory.map((o, i) => event(o, 'series', i)), ...mvHistory.map((o, i) => event(o, 'movie', i))];
  const undated = history.filter((h) => !h.timestamp).length;
  if (undated > 0) warnings.push({ area: 'subtitleHistory', message: `${undated} history entries have no absolute date in this Bazarr version's API and are skipped (import Bazarr from its files to keep them)` });

  const raw: BazarrRaw = {
    version,
    profiles: profiles.map(lowerKeys),
    config: isObj(settings) ? (settings as ConfigTree) : null,
    shows: shows.map((s) => ({
      sonarrSeriesId: int(s['sonarrSeriesId']),
      title: str(s['title']),
      path: str(s['path']),
      tvdbId: int(s['tvdbId']),
      imdbId: str(s['imdbId']) || null,
      profileId: int(s['profileId']),
    })),
    movies: movies.map((m) => ({
      radarrId: int(m['radarrId']),
      title: str(m['title']),
      path: str(m['path']),
      tmdbId: int(m['tmdbId']),
      imdbId: str(m['imdbId']) || null,
      profileId: int(m['profileId']),
      subtitles: parseSubtitleList(m['subtitles']),
    })),
    episodes: episodes.map((e) => ({
      sonarrSeriesId: int(e['sonarrSeriesId']),
      sonarrEpisodeId: int(e['sonarrEpisodeId']),
      path: str(e['path']),
      subtitles: parseSubtitleList(e['subtitles']),
    })),
    history,
    blacklist: [...epBlacklist.map((o, i) => event(o, 'series', i)), ...mvBlacklist.map((o, i) => event(o, 'movie', i))],
  };
  return buildBazarrBundle(raw, source.pathMappings, warnings);
}
