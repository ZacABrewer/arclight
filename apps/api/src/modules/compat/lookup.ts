import { isMetadataError, type MovieMetadata, type SearchResult, type SeriesMetadata } from '@media-tron/metadata';
import type { AppContext } from '../../app.js';
import type { MovieMetadataInput, SeriesMetadataInput } from '../library/index.js';
import { MetadataNotConfiguredError, MetadataService } from '../metadata/index.js';
import { CompatError } from './common.js';

/**
 * What the compat routes need from the metadata source. The default wraps a MetadataService
 * (TMDB, settings read per call); tests inject a fake.
 */
export interface CompatMetadata {
  searchSeries(term: string): Promise<SearchResult[]>;
  searchMovies(term: string): Promise<SearchResult[]>;
  findByTvdbId(tvdbId: number): Promise<SearchResult[]>;
  findByImdbId(imdbId: string): Promise<SearchResult[]>;
  getSeries(tmdbId: number): Promise<SeriesMetadata>;
  getMovie(tmdbId: number): Promise<MovieMetadata>;
  /** Library-shaped series (with episodes) for adding, or null when unknown. */
  lookupSeries(tmdbId: number): Promise<SeriesMetadataInput | null>;
  lookupMovie(tmdbId: number): Promise<MovieMetadataInput | null>;
}

export function defaultCompatMetadata(ctx: AppContext): CompatMetadata {
  const service = new MetadataService({ db: ctx.db, log: ctx.log.child({ module: 'compat-metadata' }) });
  return {
    searchSeries: async (term) => (await service.client().searchSeries(term)).results,
    searchMovies: async (term) => (await service.client().searchMovies(term)).results,
    findByTvdbId: (id) => service.client().findByTvdbId(id),
    findByImdbId: (id) => service.client().findByImdbId(id),
    getSeries: (id) => service.getSeries(id),
    getMovie: (id) => service.getMovie(id),
    lookupSeries: (id) => service.lookupSeries(id),
    lookupMovie: (id) => service.lookupMovie(id),
  };
}

/** Metadata failures the user can fix become 400s; "not found" becomes an empty result. */
export async function guardMetadata<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MetadataNotConfiguredError) throw CompatError.validation('term', err.message);
    if (isMetadataError(err, 'not-found')) return fallback;
    if (isMetadataError(err, 'unauthorized')) throw CompatError.validation('term', 'TMDB rejected the configured API key');
    if (isMetadataError(err)) throw new CompatError(503, `Metadata lookup failed: ${err.message}`);
    throw err;
  }
}

export type LookupTerm =
  | { kind: 'tvdb'; id: number }
  | { kind: 'tmdb'; id: number }
  | { kind: 'imdb'; id: string }
  | { kind: 'text'; text: string };

/** `tvdb:123`, `tmdb:123`, `imdb:tt123` (case-insensitive) or free text. */
export function parseLookupTerm(term: string): LookupTerm {
  const t = term.trim();
  const m = /^(tvdb|tmdb|imdb)\s*:\s*(\S+)$/i.exec(t);
  if (m) {
    const kind = m[1]!.toLowerCase();
    const value = m[2]!;
    if (kind === 'imdb') return { kind: 'imdb', id: value.startsWith('tt') ? value : `tt${value}` };
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) return kind === 'tvdb' ? { kind: 'tvdb', id } : { kind: 'tmdb', id };
  }
  if (/^tt\d+$/i.test(t)) return { kind: 'imdb', id: t.toLowerCase() };
  return { kind: 'text', text: t };
}

/** Series lookup results: full metadata for id lookups, search results for free text. */
export async function lookupSeries(metadata: CompatMetadata, term: string): Promise<Array<SeriesMetadata | SearchResult>> {
  const parsed = parseLookupTerm(term);
  const full = async (tmdbIds: number[]) => {
    const out: SeriesMetadata[] = [];
    for (const id of tmdbIds.slice(0, 5)) {
      const s = await guardMetadata(() => metadata.getSeries(id), null);
      if (s) out.push(s);
    }
    return out;
  };
  switch (parsed.kind) {
    case 'tmdb':
      return full([parsed.id]);
    case 'tvdb': {
      const hits = await guardMetadata(() => metadata.findByTvdbId(parsed.id), []);
      return full(hits.filter((h) => h.mediaType === 'series').map((h) => h.tmdbId));
    }
    case 'imdb': {
      const hits = await guardMetadata(() => metadata.findByImdbId(parsed.id), []);
      return full(hits.filter((h) => h.mediaType === 'series').map((h) => h.tmdbId));
    }
    case 'text':
      if (!parsed.text) return [];
      return guardMetadata(() => metadata.searchSeries(parsed.text), []);
  }
}

export async function lookupMovies(metadata: CompatMetadata, term: string): Promise<Array<MovieMetadata | SearchResult>> {
  const parsed = parseLookupTerm(term);
  const full = async (tmdbIds: number[]) => {
    const out: MovieMetadata[] = [];
    for (const id of tmdbIds.slice(0, 5)) {
      const m = await guardMetadata(() => metadata.getMovie(id), null);
      if (m) out.push(m);
    }
    return out;
  };
  switch (parsed.kind) {
    case 'tmdb':
      return full([parsed.id]);
    case 'imdb': {
      const hits = await guardMetadata(() => metadata.findByImdbId(parsed.id), []);
      return full(hits.filter((h) => h.mediaType === 'movie').map((h) => h.tmdbId));
    }
    case 'tvdb':
      return [];
    case 'text':
      if (!parsed.text) return [];
      return guardMetadata(() => metadata.searchMovies(parsed.text), []);
  }
}

/** tvdbId -> tmdbId through TMDB's external-id lookup. */
export async function tmdbIdForTvdb(metadata: CompatMetadata, tvdbId: number): Promise<number | null> {
  const hits = await guardMetadata(() => metadata.findByTvdbId(tvdbId), []);
  return hits.find((h) => h.mediaType === 'series')?.tmdbId ?? null;
}

export async function tmdbIdForImdb(metadata: CompatMetadata, imdbId: string, mediaType: 'series' | 'movie'): Promise<number | null> {
  const hits = await guardMetadata(() => metadata.findByImdbId(imdbId), []);
  return hits.find((h) => h.mediaType === mediaType)?.tmdbId ?? null;
}
