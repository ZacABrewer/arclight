import { z } from 'zod';
import { MediaType } from './library.js';

// Library analytics: storage (per root folder, top items, quality/codec/resolution breakdowns,
// growth from daily snapshots), library counts and activity per day.

const int = () => z.number().int();

export const StatsBucket = z.object({ key: z.string(), count: int(), sizeBytes: int() });
export type StatsBucket = z.infer<typeof StatsBucket>;

export const StatsRootFolder = z.object({
  path: z.string(),
  mediaType: MediaType,
  accessible: z.boolean(),
  totalBytes: int().nullable(),
  freeBytes: int().nullable(),
  usedByArclightBytes: int(),
  fileCount: int(),
});
export type StatsRootFolder = z.infer<typeof StatsRootFolder>;

export const StatsTopItem = z.object({
  mediaType: MediaType,
  id: int(),
  title: z.string(),
  year: int(),
  sizeBytes: int(),
  fileCount: int(),
});
export type StatsTopItem = z.infer<typeof StatsTopItem>;

export const StatsGrowthPoint = z.object({ date: z.string(), usedBytes: int(), fileCount: int() });
export type StatsGrowthPoint = z.infer<typeof StatsGrowthPoint>;

export const StatsGrowthWindow = z.object({
  days: int(),
  /** Library size at the oldest snapshot inside the window; null when there is none. */
  fromBytes: int().nullable(),
  toBytes: int(),
  deltaBytes: int().nullable(),
});
export type StatsGrowthWindow = z.infer<typeof StatsGrowthWindow>;

export const StorageStatsQuery = z.object({
  top: z.coerce.number().int().min(1).max(100).default(10),
});
export type StorageStatsQuery = z.infer<typeof StorageStatsQuery>;

export const StorageStats = z.object({
  totalUsedBytes: int(),
  totalFiles: int(),
  rootFolders: z.array(StatsRootFolder),
  topSeries: z.array(StatsTopItem),
  topMovies: z.array(StatsTopItem),
  byQuality: z.array(StatsBucket),
  byVideoCodec: z.array(StatsBucket),
  byResolution: z.array(StatsBucket),
  byDynamicRange: z.array(StatsBucket),
  growth: z.object({
    last30: StatsGrowthWindow,
    last90: StatsGrowthWindow,
    /** Daily library size for the last 90 days (snapshot days only, oldest first). */
    points: z.array(StatsGrowthPoint),
  }),
});
export type StorageStats = z.infer<typeof StorageStats>;

export const LibraryStats = z.object({
  series: z.object({ total: int(), monitored: int(), continuing: int(), ended: int() }),
  episodes: z.object({
    total: int(),
    downloaded: int(),
    /** Monitored, aired, no file. */
    missing: int(),
    /** Monitored, not aired yet (or no air date), no file. */
    unaired: int(),
    /** Unmonitored without a file. */
    unmonitored: int(),
    cutoffUnmet: int(),
  }),
  movies: z.object({ total: int(), monitored: int(), downloaded: int(), missing: int(), cutoffUnmet: int() }),
  files: z.object({ total: int(), sizeBytes: int() }),
});
export type LibraryStats = z.infer<typeof LibraryStats>;

export const ActivityStatsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});
export type ActivityStatsQuery = z.infer<typeof ActivityStatsQuery>;

export const ActivityDay = z.object({ date: z.string(), grabbed: int(), imported: int(), failed: int() });
export type ActivityDay = z.infer<typeof ActivityDay>;

export const ActivityStats = z.object({
  days: int(),
  since: z.string(),
  totals: z.object({ grabbed: int(), imported: int(), failed: int() }),
  perDay: z.array(ActivityDay),
});
export type ActivityStats = z.infer<typeof ActivityStats>;
