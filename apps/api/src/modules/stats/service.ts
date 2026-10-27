import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, gte, inArray, lt } from 'drizzle-orm';
import type {
  ActivityStats,
  IndexerStats,
  LibraryStats,
  MediaFile,
  MediaInfo,
  QualityModel,
  StatsBucket,
  StatsGrowthWindow,
  StatsRootFolder,
  StatsTopItem,
  StorageStats,
} from '@arclight/shared';
import { episodeAiredMs } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, history, mediaFiles, movies, rootFolders, series } from '../../db/schema.js';
import { libraryService, type IsCutoffMet } from '../library/index.js';
import { statsSnapshots } from './schema.js';

// Library analytics over the library, history and snapshot tables. Read-only except for the
// daily snapshot.

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

export type DiskUsageFn = (path: string) => Promise<DiskUsage | null>;

export interface StatsServiceOptions {
  db: Db;
  /** Indexer usage (indexers module), proxied by GET /stats/indexers. */
  indexerStats?: (days: number) => IndexerStats;
  /** Builds a cutoff checker (one per request). Without it cutoff counts are 0. */
  cutoffChecker?: () => IsCutoffMet;
  diskUsage?: DiskUsageFn;
  now?: () => Date;
}

export class StatsError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'StatsError';
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** Total/free bytes of the volume holding `path` (walking up to an existing folder). */
export const nodeDiskUsage: DiskUsageFn = async (path) => {
  let current = path;
  for (;;) {
    try {
      const s = await statfs(current);
      return { totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) };
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
};

/** 2160p / 1080p / 720p / SD / Unknown from probed dimensions, falling back to the quality. */
export function resolutionBucket(info: MediaInfo | null | undefined, quality: QualityModel): string {
  let width = info?.width ?? 0;
  let height = info?.height ?? 0;
  if ((!width || !height) && info?.resolution) {
    const m = /^(\d+)x(\d+)$/.exec(info.resolution);
    if (m) {
      width = Number(m[1]);
      height = Number(m[2]);
    }
  }
  if (!height) height = quality.quality.resolution;
  if (height >= 1800 || width >= 3200) return '2160p';
  if (height >= 900 || width >= 1800) return '1080p';
  if (height >= 600 || width >= 1200) return '720p';
  if (height > 0) return 'SD';
  return 'Unknown';
}

function bucketize<T>(items: readonly T[], key: (item: T) => string, size: (item: T) => number): StatsBucket[] {
  const map = new Map<string, StatsBucket>();
  for (const item of items) {
    const k = key(item);
    const b = map.get(k) ?? { key: k, count: 0, sizeBytes: 0 };
    b.count++;
    b.sizeBytes += size(item);
    map.set(k, b);
  }
  return [...map.values()].sort((a, b) => b.sizeBytes - a.sizeBytes || a.key.localeCompare(b.key));
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export class StatsService {
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly diskUsage: DiskUsageFn;

  constructor(private readonly opts: StatsServiceOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => new Date());
    this.diskUsage = opts.diskUsage ?? nodeDiskUsage;
  }

  /** Every media file with the root folder of its series/movie. */
  private filesWithParents() {
    const seriesRows = this.db.select({ id: series.id, title: series.title, year: series.year, root: series.rootFolderPath }).from(series).all();
    const movieRows = this.db.select({ id: movies.id, title: movies.title, year: movies.year, root: movies.rootFolderPath }).from(movies).all();
    const seriesById = new Map(seriesRows.map((s) => [s.id, s]));
    const moviesById = new Map(movieRows.map((m) => [m.id, m]));
    const files = this.db
      .select({
        id: mediaFiles.id,
        mediaType: mediaFiles.mediaType,
        seriesId: mediaFiles.seriesId,
        movieId: mediaFiles.movieId,
        sizeBytes: mediaFiles.sizeBytes,
        quality: mediaFiles.quality,
        mediaInfo: mediaFiles.mediaInfo,
      })
      .from(mediaFiles)
      .all()
      .map((f) => {
        const parent = f.mediaType === 'series' ? (f.seriesId != null ? seriesById.get(f.seriesId) : undefined) : f.movieId != null ? moviesById.get(f.movieId) : undefined;
        return { ...f, parent, root: parent?.root ?? null };
      });
    return { files, seriesRows, movieRows };
  }

  private usageByRoot(files: ReturnType<StatsService['filesWithParents']>['files']) {
    const byRoot = new Map<string, { used: number; count: number }>();
    for (const f of files) {
      if (!f.root) continue;
      const u = byRoot.get(f.root) ?? { used: 0, count: 0 };
      u.used += f.sizeBytes;
      u.count++;
      byRoot.set(f.root, u);
    }
    return byRoot;
  }

  // -------------------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------------------

  async storage(top = 10): Promise<StorageStats> {
    const { files } = this.filesWithParents();
    const byRoot = this.usageByRoot(files);
    const roots = this.db.select().from(rootFolders).all();
    const rootStats: StatsRootFolder[] = [];
    for (const r of roots) {
      const disk = await this.diskUsage(r.path).catch(() => null);
      const u = byRoot.get(r.path) ?? { used: 0, count: 0 };
      rootStats.push({
        path: r.path,
        mediaType: r.mediaType,
        accessible: disk !== null,
        totalBytes: disk?.totalBytes ?? null,
        freeBytes: disk?.freeBytes ?? null,
        usedByArclightBytes: u.used,
        fileCount: u.count,
      });
    }

    const topOf = (mediaType: 'series' | 'movie'): StatsTopItem[] => {
      const map = new Map<number, StatsTopItem>();
      for (const f of files) {
        if (f.mediaType !== mediaType || !f.parent) continue;
        const item = map.get(f.parent.id) ?? { mediaType, id: f.parent.id, title: f.parent.title, year: f.parent.year, sizeBytes: 0, fileCount: 0 };
        item.sizeBytes += f.sizeBytes;
        item.fileCount++;
        map.set(f.parent.id, item);
      }
      return [...map.values()].sort((a, b) => b.sizeBytes - a.sizeBytes || a.title.localeCompare(b.title)).slice(0, top);
    };

    const totalUsedBytes = files.reduce((n, f) => n + f.sizeBytes, 0);
    const size = (f: { sizeBytes: number }) => f.sizeBytes;
    return {
      totalUsedBytes,
      totalFiles: files.length,
      rootFolders: rootStats,
      topSeries: topOf('series'),
      topMovies: topOf('movie'),
      byQuality: bucketize(files, (f) => f.quality.quality.name, size),
      byVideoCodec: bucketize(files, (f) => f.mediaInfo?.videoCodec || 'Unknown', size),
      byResolution: bucketize(files, (f) => resolutionBucket(f.mediaInfo, f.quality), size),
      byDynamicRange: bucketize(files, (f) => f.mediaInfo?.videoDynamicRange || 'Unknown', size),
      growth: this.growth(totalUsedBytes),
    };
  }

  private growth(currentBytes: number): StorageStats['growth'] {
    const today = this.now();
    const since = isoDay(new Date(today.getTime() - 90 * DAY));
    const rows = this.db.select().from(statsSnapshots).where(gte(statsSnapshots.date, since)).all();
    const perDay = new Map<string, { usedBytes: number; fileCount: number }>();
    for (const r of rows) {
      const p = perDay.get(r.date) ?? { usedBytes: 0, fileCount: 0 };
      p.usedBytes += r.usedBytes;
      p.fileCount += r.fileCount;
      perDay.set(r.date, p);
    }
    const points = [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, p]) => ({ date, ...p }));
    const window = (days: number): StatsGrowthWindow => {
      const from = isoDay(new Date(today.getTime() - days * DAY));
      const first = points.find((p) => p.date >= from);
      return { days, fromBytes: first?.usedBytes ?? null, toBytes: currentBytes, deltaBytes: first ? currentBytes - first.usedBytes : null };
    };
    return { last30: window(30), last90: window(90), points };
  }

  /** Write (or overwrite) today's snapshot per root folder; prunes rows older than 400 days. */
  async snapshot(): Promise<{ date: string; rootFolders: number }> {
    const now = this.now();
    const date = isoDay(now);
    const { files } = this.filesWithParents();
    const byRoot = this.usageByRoot(files);
    const roots = this.db.select().from(rootFolders).all();
    const values: Array<typeof statsSnapshots.$inferInsert & { takenAt: string }> = [];
    for (const r of roots) {
      const disk = await this.diskUsage(r.path).catch(() => null);
      const u = byRoot.get(r.path) ?? { used: 0, count: 0 };
      values.push({
        date,
        rootFolderPath: r.path,
        totalBytes: disk?.totalBytes ?? null,
        freeBytes: disk?.freeBytes ?? null,
        usedBytes: u.used,
        fileCount: u.count,
        takenAt: now.toISOString(),
      });
    }
    this.db.transaction((tx) => {
      for (const v of values) {
        tx.insert(statsSnapshots)
          .values(v)
          .onConflictDoUpdate({
            target: [statsSnapshots.date, statsSnapshots.rootFolderPath],
            set: { totalBytes: v.totalBytes, freeBytes: v.freeBytes, usedBytes: v.usedBytes, fileCount: v.fileCount, takenAt: v.takenAt },
          })
          .run();
      }
      tx.delete(statsSnapshots).where(lt(statsSnapshots.date, isoDay(new Date(now.getTime() - 400 * DAY)))).run();
    });
    return { date, rootFolders: values.length };
  }

  // -------------------------------------------------------------------------------------
  // Library
  // -------------------------------------------------------------------------------------

  library(): LibraryStats {
    const nowMs = this.now().getTime();
    const seriesRows = this.db.select({ id: series.id, monitored: series.monitored, status: series.status }).from(series).all();
    const seriesMonitored = new Map(seriesRows.map((s) => [s.id, s.monitored]));
    const eps = this.db
      .select({ seriesId: episodes.seriesId, monitored: episodes.monitored, hasFile: episodes.hasFile, airDateUtc: episodes.airDateUtc, airDate: episodes.airDate, fileId: episodes.episodeFileId })
      .from(episodes)
      .all();
    const ep = { total: eps.length, downloaded: 0, missing: 0, unaired: 0, unmonitored: 0, cutoffUnmet: 0 };
    for (const e of eps) {
      if (e.hasFile) ep.downloaded++;
      else if (!e.monitored || !seriesMonitored.get(e.seriesId)) ep.unmonitored++;
      else if ((episodeAiredMs(e) ?? Infinity) <= nowMs) ep.missing++;
      else ep.unaired++;
    }
    const movieRows = this.db.select({ id: movies.id, monitored: movies.monitored, hasFile: movies.hasFile, fileId: movies.movieFileId }).from(movies).all();
    const now = this.now().toISOString();
    const missingMovies = libraryService.listMissingMovies(this.db, { page: 1, pageSize: 1 }, now).totalRecords;

    const files = this.db.select({ n: mediaFiles.id, size: mediaFiles.sizeBytes }).from(mediaFiles).all();

    // Cutoff: monitored episodes (of monitored series) / monitored movies whose file is below cutoff.
    let episodeCutoff = 0;
    let movieCutoff = 0;
    if (this.opts.cutoffChecker) {
      const met = this.opts.cutoffChecker();
      const fileIds = new Set<number>();
      for (const e of eps) if (e.fileId != null && e.monitored && seriesMonitored.get(e.seriesId)) fileIds.add(e.fileId);
      for (const m of movieRows) if (m.fileId != null && m.monitored) fileIds.add(m.fileId);
      const unmet = new Set<number>();
      const ids = [...fileIds];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const rows = this.db.select().from(mediaFiles).where(inArray(mediaFiles.id, chunk)).all();
        for (const row of rows) {
          const file: MediaFile = { ...row, episodeIds: [] };
          if (!met(file)) unmet.add(row.id);
        }
      }
      for (const e of eps) if (e.fileId != null && e.monitored && seriesMonitored.get(e.seriesId) && unmet.has(e.fileId)) episodeCutoff++;
      for (const m of movieRows) if (m.fileId != null && m.monitored && unmet.has(m.fileId)) movieCutoff++;
    }
    ep.cutoffUnmet = episodeCutoff;

    return {
      series: {
        total: seriesRows.length,
        monitored: seriesRows.filter((s) => s.monitored).length,
        continuing: seriesRows.filter((s) => s.status === 'continuing' || s.status === 'upcoming').length,
        ended: seriesRows.filter((s) => s.status === 'ended').length,
      },
      episodes: ep,
      movies: {
        total: movieRows.length,
        monitored: movieRows.filter((m) => m.monitored).length,
        downloaded: movieRows.filter((m) => m.hasFile).length,
        missing: missingMovies,
        cutoffUnmet: movieCutoff,
      },
      files: { total: files.length, sizeBytes: files.reduce((n, f) => n + f.size, 0) },
    };
  }

  // -------------------------------------------------------------------------------------
  // Activity
  // -------------------------------------------------------------------------------------

  /**
   * Grabs, imports and failures per UTC day. History holds one row per episode, so a season
   * pack would count once per episode; rows are collapsed per download id (grabs, failures)
   * and per imported path (imports).
   */
  activity(days = 30): ActivityStats {
    const now = this.now();
    const startDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * DAY);
    const since = startDay.toISOString();
    const rows = this.db
      .select({ id: history.id, eventType: history.eventType, date: history.date, downloadId: history.downloadId, data: history.data })
      .from(history)
      .where(and(gte(history.date, since), inArray(history.eventType, ['grabbed', 'downloadFolderImported', 'downloadFailed'])))
      .all();
    const perDay = new Map<string, { grabbed: Set<string>; imported: Set<string>; failed: Set<string> }>();
    for (let i = 0; i < days; i++) {
      perDay.set(isoDay(new Date(startDay.getTime() + i * DAY)), { grabbed: new Set(), imported: new Set(), failed: new Set() });
    }
    for (const r of rows) {
      const day = perDay.get(r.date.slice(0, 10));
      if (!day) continue;
      if (r.eventType === 'grabbed') day.grabbed.add(r.downloadId ?? `#${r.id}`);
      else if (r.eventType === 'downloadFailed') day.failed.add(r.downloadId ?? `#${r.id}`);
      else day.imported.add(r.data?.['importedPath'] ?? `#${r.id}`);
    }
    const list = [...perDay.entries()].map(([date, d]) => ({ date, grabbed: d.grabbed.size, imported: d.imported.size, failed: d.failed.size }));
    return {
      days,
      since,
      totals: {
        grabbed: list.reduce((n, d) => n + d.grabbed, 0),
        imported: list.reduce((n, d) => n + d.imported, 0),
        failed: list.reduce((n, d) => n + d.failed, 0),
      },
      perDay: list,
    };
  }

  indexers(days: number): IndexerStats {
    if (!this.opts.indexerStats) throw new StatsError('UNAVAILABLE', 'indexer statistics are not available');
    return this.opts.indexerStats(days);
  }
}
