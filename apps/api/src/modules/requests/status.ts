import { inArray } from 'drizzle-orm';
import type { MediaStatus, MediaType, RequestStatus } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, movies, seasons, series } from '../../db/schema.js';
import type { SeasonStatusEntry } from './schema.js';

// Availability of titles, computed from the library (docs/spec/requests.md section 10,
// adapted: Arclight's own library replaces the Radarr/Sonarr/Plex scanners). Two tracks:
// "normal" counts any file, "4K" counts files whose quality resolution is 2160 or more.

export const UHD_RESOLUTION = 2160;

const RANK: Record<MediaStatus, number> = { unknown: 0, pending: 1, processing: 2, partiallyAvailable: 3, available: 4 };

export function statusRank(status: MediaStatus): number {
  return RANK[status];
}

export function maxStatus(a: MediaStatus, b: MediaStatus): MediaStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

export interface LibraryAvailability {
  libraryId: number;
  status: MediaStatus;
  status4k: MediaStatus;
  /** Series only: every season the library knows, specials included. */
  seasons: SeasonStatusEntry[];
}

export interface AvailabilityOptions {
  now?: Date;
  /** Count season 0 toward the series rollup. */
  includeSpecials?: boolean;
}

function isUhd(quality: { quality?: { resolution?: number } } | null | undefined): boolean {
  return (quality?.quality?.resolution ?? 0) >= UHD_RESOLUTION;
}

export function movieAvailability(db: Db, tmdbIds: readonly number[]): Map<number, LibraryAvailability> {
  const out = new Map<number, LibraryAvailability>();
  if (tmdbIds.length === 0) return out;
  const rows = db.select().from(movies).where(inArray(movies.tmdbId, [...new Set(tmdbIds)])).all();
  if (rows.length === 0) return out;
  const files = db
    .select({ movieId: mediaFiles.movieId, quality: mediaFiles.quality })
    .from(mediaFiles)
    .where(inArray(mediaFiles.movieId, rows.map((r) => r.id)))
    .all();
  for (const row of rows) {
    const own = files.filter((f) => f.movieId === row.id);
    const hasFile = row.hasFile || own.length > 0;
    out.set(row.tmdbId, {
      libraryId: row.id,
      status: hasFile ? 'available' : row.monitored ? 'processing' : 'unknown',
      status4k: own.some((f) => isUhd(f.quality)) ? 'available' : 'unknown',
      seasons: [],
    });
  }
  return out;
}

/** Rollup of season statuses into the series status (section 10.2.4). */
export function rollupSeasons(statuses: readonly MediaStatus[], fallback: MediaStatus): MediaStatus {
  if (statuses.length === 0) return fallback;
  if (statuses.every((s) => s === 'available')) return 'available';
  if (statuses.some((s) => s === 'available' || s === 'partiallyAvailable')) return 'partiallyAvailable';
  if (statuses.some((s) => s === 'processing')) return 'processing';
  return 'unknown';
}

export function seriesAvailability(db: Db, tmdbIds: readonly number[], opts: AvailabilityOptions = {}): Map<number, LibraryAvailability> {
  const out = new Map<number, LibraryAvailability>();
  if (tmdbIds.length === 0) return out;
  const nowIso = (opts.now ?? new Date()).toISOString();
  const rows = db.select().from(series).where(inArray(series.tmdbId, [...new Set(tmdbIds)])).all();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const seasonRows = db.select().from(seasons).where(inArray(seasons.seriesId, ids)).all();
  const episodeRows = db
    .select({
      seriesId: episodes.seriesId,
      seasonNumber: episodes.seasonNumber,
      airDateUtc: episodes.airDateUtc,
      hasFile: episodes.hasFile,
      episodeFileId: episodes.episodeFileId,
    })
    .from(episodes)
    .where(inArray(episodes.seriesId, ids))
    .all();
  const fileRows = db
    .select({ id: mediaFiles.id, quality: mediaFiles.quality })
    .from(mediaFiles)
    .where(inArray(mediaFiles.seriesId, ids))
    .all();
  const uhdFiles = new Set(fileRows.filter((f) => isUhd(f.quality)).map((f) => f.id));

  for (const row of rows) {
    const entries: SeasonStatusEntry[] = [];
    for (const season of seasonRows.filter((s) => s.seriesId === row.id).sort((a, b) => a.seasonNumber - b.seasonNumber)) {
      const eps = episodeRows.filter((e) => e.seriesId === row.id && e.seasonNumber === season.seasonNumber);
      const aired = eps.filter((e) => e.airDateUtc !== null && e.airDateUtc <= nowIso);
      // Nothing aired yet: judge by whatever episodes exist (all of them may have files early).
      const judged = aired.length > 0 ? aired : eps;
      const withFile = eps.filter((e) => e.hasFile);
      const with4k = eps.filter((e) => e.hasFile && e.episodeFileId !== null && uhdFiles.has(e.episodeFileId));
      const status: MediaStatus =
        withFile.length > 0 && judged.length > 0 && judged.every((e) => e.hasFile)
          ? 'available'
          : withFile.length > 0
            ? 'partiallyAvailable'
            : season.monitored
              ? 'processing'
              : 'unknown';
      const status4k: MediaStatus =
        with4k.length > 0 && judged.length > 0 && judged.every((e) => e.hasFile && e.episodeFileId !== null && uhdFiles.has(e.episodeFileId))
          ? 'available'
          : with4k.length > 0
            ? 'partiallyAvailable'
            : 'unknown';
      entries.push({ seasonNumber: season.seasonNumber, status, status4k });
    }
    const counted = entries.filter((e) => opts.includeSpecials || e.seasonNumber > 0);
    out.set(row.tmdbId, {
      libraryId: row.id,
      status: rollupSeasons(counted.map((e) => e.status), row.monitored ? 'processing' : 'unknown'),
      status4k: rollupSeasons(counted.map((e) => e.status4k), 'unknown'),
      seasons: entries,
    });
  }
  return out;
}

export function libraryAvailability(db: Db, type: MediaType, tmdbIds: readonly number[], opts: AvailabilityOptions = {}): Map<number, LibraryAvailability> {
  return type === 'movie' ? movieAvailability(db, tmdbIds) : seriesAvailability(db, tmdbIds, opts);
}

/**
 * Lifts a library status with the requests on that track: an approved request means the
 * title is at least processing, a pending one at least pending (section 7.2).
 */
export function overlayRequests(base: MediaStatus, requestStatuses: readonly RequestStatus[]): MediaStatus {
  let status = base;
  if (requestStatuses.some((s) => s === 'approved' || s === 'failed')) status = maxStatus(status, 'processing');
  if (requestStatuses.some((s) => s === 'pending')) status = maxStatus(status, 'pending');
  return status;
}

/** Season statuses keyed by number for one track. */
export function seasonStatusMap(entries: readonly SeasonStatusEntry[], is4k: boolean): Map<number, MediaStatus> {
  return new Map(entries.map((e) => [e.seasonNumber, is4k ? e.status4k : e.status]));
}
