import type { FetchLike, TmdbClient } from '@media-tron/metadata';
import type { ImportListImplementation, ImportListMediaType, ImportListSettingsMap } from '@media-tron/shared';
import type { Logger } from 'pino';

export type { FetchLike };

/** One entry a provider found. Items without a tmdbId are resolved through TMDB by imdb/tvdb id. */
export interface FetchedItem {
  mediaType: 'series' | 'movie';
  tmdbId?: number | null;
  imdbId?: string | null;
  tvdbId?: number | null;
  title: string;
  year?: number | null;
}

/** TMDB access built from the stored metadata key. */
export interface TmdbAccess {
  client: TmdbClient;
  /** Raw GET for endpoints the shared client does not wrap (lists, collections, credits). */
  get(path: string, params?: Record<string, string | number | undefined>): Promise<unknown>;
}

export interface ProviderContext {
  fetch: FetchLike;
  log: Logger;
  signal?: AbortSignal;
  now: () => Date;
  /** Throws ImportListFetchError('not-configured') when no TMDB key is available. */
  tmdb(): TmdbAccess;
  /** Persist changed settings (refreshed OAuth tokens). A no-op for unsaved lists. */
  saveSettings(patch: Record<string, unknown>): void;
}

export type Provider<K extends ImportListImplementation> = (
  settings: ImportListSettingsMap[K],
  mediaType: ImportListMediaType,
  ctx: ProviderContext,
) => Promise<FetchedItem[]>;

export type ProviderRegistry = { [K in ImportListImplementation]: Provider<K> };

/** TMDB/Trakt kinds a list's media type asks for. */
export function wants(mediaType: ImportListMediaType, kind: 'series' | 'movie'): boolean {
  return mediaType === 'both' || mediaType === kind;
}

export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

export function inYearRange(year: number | null | undefined, from?: number, to?: number): boolean {
  if (from === undefined && to === undefined) return true;
  if (year === null || year === undefined) return false;
  return (from === undefined || year >= from) && (to === undefined || year <= to);
}
