import type { Job, RefreshCommand } from '@arclight/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { movies, series } from '../../db/schema.js';
import type { JobHandler, Scheduler } from '../../scheduler.js';
import { libraryService } from '../library/index.js';
import { refreshAllMovies, refreshAllSeries } from './jobs.js';
import type { MetadataService } from './service.js';

export const REFRESH_SERIES_ITEM_JOB = 'RefreshSeriesItem';
export const REFRESH_MOVIE_ITEM_JOB = 'RefreshMovieItem';
export const REFRESH_LIBRARY_JOB = 'RefreshLibrary';

/** Re-reads an item's folder (or every folder) from disk; supplied by the imports module. */
export interface RescanPort {
  series(id: number): Promise<{ scanned: number }>;
  movie(id: number): Promise<{ scanned: number }>;
  all(): Promise<{ scanned: number }>;
}

export class RefreshTargetNotFound extends Error {
  readonly code = 'NOT_FOUND';
  constructor(kind: 'series' | 'movie', ids: number[]) {
    super(`${kind} not found: ${ids.join(', ')}`);
    this.name = 'RefreshTargetNotFound';
  }
}

export interface Started {
  job: Job;
  done: Promise<Job>;
}

/**
 * On-demand metadata refreshes. Each call starts an ad-hoc scheduler job (a `jobs` row plus
 * `job` events, see Scheduler.runTask) and returns at once; the HTTP layer answers 202 with the
 * running Job. Item refreshes are keyed per item, so two series refresh in parallel but the
 * same series never twice at a time.
 */
export class MetadataRefresher {
  constructor(
    private readonly db: Db,
    private readonly scheduler: Scheduler,
    private readonly service: MetadataService,
    private readonly rescan: () => RescanPort | null = () => null,
    private readonly bus?: EventBus,
  ) {}

  /** POST /command/refresh. Throws RefreshTargetNotFound (before any job starts) for unknown ids. */
  start(cmd: RefreshCommand): Started {
    if (cmd.seriesId !== undefined) return this.series([cmd.seriesId], { rescan: cmd.rescan });
    if (cmd.movieId !== undefined) return this.movies([cmd.movieId], { rescan: cmd.rescan });
    return this.scheduler.runTask(REFRESH_LIBRARY_JOB, 'manual', async (ctx) => {
      const parts = [await refreshAllSeries(this.deps(), ctx), await refreshAllMovies(this.deps(), ctx)];
      const port = cmd.rescan ? this.rescan() : null;
      if (port && !ctx.signal.aborted) parts.push(`rescanned ${(await port.all()).scanned} files`);
      return parts.join('; ');
    });
  }

  series(ids: number[], opts: { rescan?: boolean; trigger?: Job['trigger'] } = {}): Started {
    const rows = this.db.select({ id: series.id, tmdbId: series.tmdbId }).from(series).where(inArray(series.id, ids)).all();
    const missing = ids.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) throw new RefreshTargetNotFound('series', missing);
    return this.scheduler.runTask(REFRESH_SERIES_ITEM_JOB, opts.trigger ?? 'manual', this.itemHandler('series', rows, opts.rescan ?? false), {
      key: `${REFRESH_SERIES_ITEM_JOB}:${[...ids].sort((a, b) => a - b).join(',')}`,
    });
  }

  movies(ids: number[], opts: { rescan?: boolean; trigger?: Job['trigger'] } = {}): Started {
    const rows = this.db.select({ id: movies.id, tmdbId: movies.tmdbId }).from(movies).where(inArray(movies.id, ids)).all();
    const missing = ids.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) throw new RefreshTargetNotFound('movie', missing);
    return this.scheduler.runTask(REFRESH_MOVIE_ITEM_JOB, opts.trigger ?? 'manual', this.itemHandler('movie', rows, opts.rescan ?? false), {
      key: `${REFRESH_MOVIE_ITEM_JOB}:${[...ids].sort((a, b) => a - b).join(',')}`,
    });
  }

  private deps() {
    return { db: this.db, service: this.service };
  }

  private itemHandler(kind: 'series' | 'movie', rows: Array<{ id: number; tmdbId: number }>, rescan: boolean): JobHandler {
    return async ({ signal, log }) => {
      if (!this.service.isConfigured()) throw new Error('TMDB API key is not configured');
      let refreshed = 0;
      const failures: string[] = [];
      for (const row of rows) {
        if (signal.aborted) break;
        try {
          await this.refreshOne(kind, row, log);
          refreshed++;
        } catch (err) {
          log.warn({ err, [`${kind}Id`]: row.id }, `${kind} refresh failed`);
          failures.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      let scanned = 0;
      const port = rescan ? this.rescan() : null;
      if (port) {
        for (const row of rows) {
          if (signal.aborted) break;
          scanned += (kind === 'series' ? await port.series(row.id) : await port.movie(row.id)).scanned;
        }
      }
      // A single-item refresh that failed is a failed job, so the UI shows the reason.
      if (rows.length === 1 && failures.length === 1) throw new Error(failures[0]!.replace(/^\d+: /, ''));
      const label = kind === 'series' ? 'series' : rows.length === 1 ? 'movie' : 'movies';
      return [
        `refreshed ${refreshed} of ${rows.length} ${label}`,
        ...(failures.length ? [`${failures.length} failed`] : []),
        ...(port ? [`rescanned ${scanned} files`] : []),
      ].join(', ');
    };
  }

  private async refreshOne(kind: 'series' | 'movie', row: { id: number; tmdbId: number }, log: Logger): Promise<void> {
    if (kind === 'series') {
      const meta = await this.service.lookupSeries(row.tmdbId);
      if (!meta) throw new Error(`series ${row.id} (tmdb ${row.tmdbId}) no longer exists at TMDB`);
      // The row may have been deleted while TMDB answered.
      if (!this.db.select({ id: series.id }).from(series).where(eq(series.id, row.id)).get()) return;
      libraryService.refreshSeriesMetadata(this.db, row.id, meta);
      this.bus?.publish({ type: 'library', action: 'updated', mediaType: 'series', id: row.id });
    } else {
      const meta = await this.service.lookupMovie(row.tmdbId);
      if (!meta) throw new Error(`movie ${row.id} (tmdb ${row.tmdbId}) no longer exists at TMDB`);
      if (!this.db.select({ id: movies.id }).from(movies).where(eq(movies.id, row.id)).get()) return;
      libraryService.refreshMovieMetadata(this.db, row.id, meta);
      this.bus?.publish({ type: 'library', action: 'updated', mediaType: 'movie', id: row.id });
    }
    log.debug({ kind, id: row.id }, 'refreshed');
  }
}
