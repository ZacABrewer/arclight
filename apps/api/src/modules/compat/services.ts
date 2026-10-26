import { and, gt, isNotNull, lte, max, min } from 'drizzle-orm';
import { CompatSettings, type MediaFile, type Movie, type Series } from '@media-tron/shared';
import type { AppContext } from '../../app.js';
import type { Db } from '../../db/index.js';
import { episodes as episodesTable } from '../../db/schema.js';
import { libraryService as lib } from '../library/index.js';
import { ProfilesService } from '../profiles/index.js';
import { releasesServiceFor } from '../releases/index.js';
import { getSection } from '../settings/service.js';
import type { CommandRunner } from './commands.js';
import type { Json } from './common.js';
import type { CompatMetadata } from './lookup.js';
import { toV3EpisodeFile, toV3Movie, toV3MovieFile, toV3Series, type SeriesExtras } from './media.js';

/** Everything the compat route files share. Services are resolved lazily, per call. */
export interface CompatServices {
  ctx: AppContext;
  db: Db;
  metadata: CompatMetadata;
  runner: CommandRunner;
  profiles: ProfilesService;
  settings(): CompatSettings;
  announce(action: 'added' | 'updated' | 'deleted' | 'fileDeleted', mediaType: 'series' | 'movie', id: number): void;
  /** Cutoff check against each item's current profile; true (met) when it cannot be evaluated. */
  cutoffChecker(): (file: MediaFile) => boolean;
  seriesExtras(): Map<number, SeriesExtras>;
  seriesJson(series: Series, extras?: Map<number, SeriesExtras>): Json;
  seriesJsonById(id: number): Json;
  movieJson(movie: Movie, cutoff?: (file: MediaFile) => boolean): Json;
}

export function createServices(ctx: AppContext, metadata: CompatMetadata, runner: CommandRunner): CompatServices {
  const db = ctx.db;
  const profiles = new ProfilesService({ db, log: ctx.log.child({ module: 'compat-profiles' }) });

  const cutoffChecker = (): ((file: MediaFile) => boolean) => {
    try {
      return releasesServiceFor(ctx).isFileCutoffMet();
    } catch (err) {
      ctx.log.debug({ err }, 'cutoff check unavailable');
      return () => true;
    }
  };

  /** First / last aired (UTC) per series, regular seasons only, from one aggregate query. */
  const seriesExtras = (): Map<number, SeriesExtras> => {
    const now = new Date().toISOString();
    const t = episodesTable;
    const first = db
      .select({ seriesId: t.seriesId, first: min(t.airDateUtc) })
      .from(t)
      .where(and(gt(t.seasonNumber, 0), isNotNull(t.airDateUtc)))
      .groupBy(t.seriesId)
      .all();
    const last = db
      .select({ seriesId: t.seriesId, last: max(t.airDateUtc) })
      .from(t)
      .where(and(gt(t.seasonNumber, 0), isNotNull(t.airDateUtc), lte(t.airDateUtc, now)))
      .groupBy(t.seriesId)
      .all();
    const map = new Map<number, SeriesExtras>();
    for (const r of first) map.set(r.seriesId, { firstAired: r.first ?? null });
    for (const r of last) {
      const entry = map.get(r.seriesId) ?? {};
      entry.lastAired = r.last ?? null;
      entry.airTime = r.last ? r.last.slice(11, 16) : null;
      map.set(r.seriesId, entry);
    }
    return map;
  };

  const seriesJson = (series: Series, extras = seriesExtras()): Json => toV3Series(series, extras.get(series.id) ?? {});

  const movieJson = (movie: Movie, cutoff = cutoffChecker()): Json => {
    let movieFile: Json | undefined;
    if (movie.movieFileId) {
      try {
        const file = lib.getMediaFile(db, movie.movieFileId);
        movieFile = toV3MovieFile(file, !cutoff(file));
      } catch {
        movieFile = undefined;
      }
    }
    return toV3Movie(movie, { movieFile });
  };

  return {
    ctx,
    db,
    metadata,
    runner,
    profiles,
    settings: () => getSection(db, 'compat'),
    announce: (action, mediaType, id) => ctx.bus.publish({ type: 'library', action, mediaType, id }),
    cutoffChecker,
    seriesExtras,
    seriesJson,
    seriesJsonById: (id) => seriesJson(lib.getSeries(db, id)),
    movieJson,
  };
}

/** Episode file resource with the cutoff flag. */
export function episodeFileJson(file: MediaFile, cutoff: (file: MediaFile) => boolean): Json {
  return toV3EpisodeFile(file, !cutoff(file));
}

/** Parse a stored compat section (also used by the /api/v1 settings routes). */
export function parseCompatSettings(value: unknown): CompatSettings {
  return CompatSettings.parse(value ?? {});
}
