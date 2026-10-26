import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { movies, series } from '../../db/schema.js';
import type { Scheduler } from '../../scheduler.js';
import { libraryService } from '../library/index.js';
import type { MetadataService } from './service.js';

export const REFRESH_SERIES_JOB = 'RefreshSeries';
export const REFRESH_MOVIE_JOB = 'RefreshMovie';

interface RefreshDeps {
  db: Db;
  service: MetadataService;
}

/** Re-fetch metadata for every series and write it through the library's refresh upsert. */
export async function refreshAllSeries(
  { db, service }: RefreshDeps,
  { signal, log }: { signal: AbortSignal; log: Logger },
): Promise<string> {
  if (!service.isConfigured()) return 'skipped: TMDB API key not configured';
  const rows = db.select({ id: series.id, tmdbId: series.tmdbId, title: series.title }).from(series).all();
  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    if (signal.aborted) break;
    try {
      const meta = await service.lookupSeries(row.tmdbId);
      if (!meta) {
        log.warn({ seriesId: row.id, tmdbId: row.tmdbId }, 'series no longer exists at TMDB; left unchanged');
        failed++;
        continue;
      }
      libraryService.refreshSeriesMetadata(db, row.id, meta);
      refreshed++;
    } catch (err) {
      log.warn({ err, seriesId: row.id, title: row.title }, 'series refresh failed');
      failed++;
    }
  }
  return `refreshed ${refreshed} of ${rows.length} series${failed ? `, ${failed} failed` : ''}`;
}

/** Re-fetch metadata for every movie and write it through the library's refresh upsert. */
export async function refreshAllMovies(
  { db, service }: RefreshDeps,
  { signal, log }: { signal: AbortSignal; log: Logger },
): Promise<string> {
  if (!service.isConfigured()) return 'skipped: TMDB API key not configured';
  const rows = db.select({ id: movies.id, tmdbId: movies.tmdbId, title: movies.title }).from(movies).all();
  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    if (signal.aborted) break;
    try {
      const meta = await service.lookupMovie(row.tmdbId);
      if (!meta) {
        log.warn({ movieId: row.id, tmdbId: row.tmdbId }, 'movie no longer exists at TMDB; left unchanged');
        failed++;
        continue;
      }
      libraryService.refreshMovieMetadata(db, row.id, meta);
      refreshed++;
    } catch (err) {
      log.warn({ err, movieId: row.id, title: row.title }, 'movie refresh failed');
      failed++;
    }
  }
  return `refreshed ${refreshed} of ${rows.length} movies${failed ? `, ${failed} failed` : ''}`;
}

export function registerMetadataJobs(scheduler: Scheduler, deps: RefreshDeps): void {
  // Daily, staggered so the two never compete for the TMDB rate limit.
  scheduler.register({ name: REFRESH_SERIES_JOB, cron: '0 3 * * *', handler: (ctx) => refreshAllSeries(deps, ctx) });
  scheduler.register({ name: REFRESH_MOVIE_JOB, cron: '30 4 * * *', handler: (ctx) => refreshAllMovies(deps, ctx) });
}
