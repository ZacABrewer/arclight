import { ImportListFetchError } from '../errors.js';
import { asRecord, imdbIdOf, int, str } from './http.js';
import type { DatasetCache, FetchedItem } from './types.js';

// Anime sites (AniList, MyAnimeList, Kitsu) know nothing about TMDB or TVDB. The Anime-IDs
// project (MIT licence, github.com/Kometa-Team/Anime-IDs) publishes one JSON object keyed by
// AniDB id whose entries carry the AniList, MAL, TVDB, TMDB and IMDb ids of the same title. It is
// downloaded once a week and cached on disk (see datasets.ts); only the data is used.

export const ANIME_IDS_URL = 'https://raw.githubusercontent.com/Kometa-Team/Anime-IDs/master/anime_ids.json';
export const ANIME_IDS_MAX_AGE_MS = 7 * 24 * 3_600_000;

export interface AnimeIds {
  tvdbId: number | null;
  tmdbShowId: number | null;
  tmdbMovieId: number | null;
  imdbId: string | null;
}

/** Ids in the file are numbers, numeric strings or comma-joined lists ("123,456"); take the first. */
function firstInt(v: unknown): number | null {
  if (typeof v === 'string' && v.includes(',')) return int(v.split(',')[0]);
  return int(v);
}

function allInts(v: unknown): number[] {
  if (typeof v === 'string') return v.split(',').map((p) => int(p.trim())).filter((n): n is number => n !== null);
  const n = int(v);
  return n === null ? [] : [n];
}

export class AnimeIdIndex {
  private constructor(
    private readonly byAnilist: Map<number, AnimeIds>,
    private readonly byMal: Map<number, AnimeIds>,
  ) {}

  static parse(json: unknown): AnimeIdIndex {
    const root = asRecord(json);
    if (!root) throw new ImportListFetchError('bad-response', 'anime id mapping is not a JSON object');
    const byAnilist = new Map<number, AnimeIds>();
    const byMal = new Map<number, AnimeIds>();
    for (const raw of Object.values(root)) {
      const r = asRecord(raw);
      if (!r) continue;
      const imdb = str(r['imdb_id']);
      const ids: AnimeIds = {
        tvdbId: firstInt(r['tvdb_id']),
        tmdbShowId: firstInt(r['tmdb_show_id']),
        tmdbMovieId: firstInt(r['tmdb_movie_id']),
        imdbId: imdbIdOf(imdb?.split(',')[0]),
      };
      if (ids.tvdbId === null && ids.tmdbShowId === null && ids.tmdbMovieId === null && !ids.imdbId) continue;
      // Several AniDB entries can share an AniList/MAL id; the first one with ids wins.
      for (const id of allInts(r['anilist_id'])) if (!byAnilist.has(id)) byAnilist.set(id, ids);
      for (const id of allInts(r['mal_id'])) if (!byMal.has(id)) byMal.set(id, ids);
    }
    return new AnimeIdIndex(byAnilist, byMal);
  }

  anilist(id: number): AnimeIds | undefined {
    return this.byAnilist.get(id);
  }

  mal(id: number): AnimeIds | undefined {
    return this.byMal.get(id);
  }

  get size(): number {
    return this.byAnilist.size + this.byMal.size;
  }
}

const parsed = new WeakMap<Buffer, AnimeIdIndex>();

/** The mapping, parsed once per download. */
export async function loadAnimeIds(datasets: DatasetCache, signal?: AbortSignal): Promise<AnimeIdIndex> {
  const data = await datasets.get('anime_ids.json', ANIME_IDS_URL, { maxAgeMs: ANIME_IDS_MAX_AGE_MS, ...(signal ? { signal } : {}) });
  let index = parsed.get(data);
  if (!index) {
    let json: unknown;
    try {
      json = JSON.parse(data.toString('utf8'));
    } catch (cause) {
      throw new ImportListFetchError('bad-response', 'anime id mapping is not valid JSON', { cause });
    }
    index = AnimeIdIndex.parse(json);
    parsed.set(data, index);
  }
  return index;
}

/** An anime site's format to a library kind. Music videos and unknown formats are skipped. */
export function animeKind(format: string | null | undefined): 'series' | 'movie' | null {
  const f = (format ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (f === 'movie') return 'movie';
  if (['tv', 'tvshort', 'ona', 'ova', 'special', 'tvspecial'].includes(f)) return 'series';
  return null;
}

/**
 * A library item for one anime entry. Without a usable mapping it carries no ids, so the resolver
 * counts it as unresolved instead of guessing by title. Movies prefer
 * the TMDB movie id; everything else maps to the series (later seasons share the first season's
 * TVDB/TMDB show, which the resolver then de-duplicates).
 */
export function animeItem(
  ids: AnimeIds | undefined,
  src: { kind: 'series' | 'movie'; title: string; year?: number | null; rating?: number | null },
): FetchedItem {
  const base = { title: src.title, year: src.year ?? null };
  if (!ids) return { ...base, mediaType: src.kind };
  if (src.kind === 'movie') {
    if (ids.tmdbMovieId) return { ...base, mediaType: 'movie', tmdbId: ids.tmdbMovieId, imdbId: ids.imdbId };
    if (ids.imdbId && !ids.tvdbId && !ids.tmdbShowId) return { ...base, mediaType: 'movie', imdbId: ids.imdbId };
  }
  if (ids.tmdbShowId) return { ...base, mediaType: 'series', tmdbId: ids.tmdbShowId };
  if (ids.tvdbId) return { ...base, mediaType: 'series', tvdbId: ids.tvdbId };
  if (ids.tmdbMovieId) return { ...base, mediaType: 'movie', tmdbId: ids.tmdbMovieId, imdbId: ids.imdbId };
  if (ids.imdbId) return { ...base, mediaType: src.kind, imdbId: ids.imdbId };
  return { ...base, mediaType: src.kind };
}

/** The anime season (winter/spring/summer/fall) a date falls in. */
export function currentSeason(now: Date): { season: 'winter' | 'spring' | 'summer' | 'fall'; year: number } {
  const m = now.getUTCMonth();
  const season = m < 3 ? 'winter' : m < 6 ? 'spring' : m < 9 ? 'summer' : 'fall';
  return { season, year: now.getUTCFullYear() };
}
