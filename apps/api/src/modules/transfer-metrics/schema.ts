import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { VpnMetricEventType } from '@arclight/shared';

// Transfer history. The sampler averages 10-second samples into one row per minute
// (resolution '1m', kept 7 days); TransferMetricsRollup folds finished hours into '1h' rows
// (kept 90 days). `samples` is how many samples a row averages, so roll-ups and re-flushes of
// the same minute stay correctly weighted. `time` is the ISO-8601 start of the minute/hour.

export type MetricResolution = '1m' | '1h';

/** Per tracked download (queue item); `info_hash` is the client-side id when sampled. */
export const transferDownloadPoints = sqliteTable(
  'transfer_download_points',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trackedDownloadId: integer('tracked_download_id').notNull(),
    infoHash: text('info_hash').notNull(),
    resolution: text('resolution').$type<MetricResolution>().notNull(),
    time: text('time').notNull(),
    samples: integer('samples').notNull(),
    downloadRate: real('download_rate').notNull(),
    uploadRate: real('upload_rate').notNull(),
    peers: real('peers').notNull(),
    seeds: real('seeds').notNull(),
    /** Highest progress (0..1) seen in the bucket. */
    progress: real('progress').notNull(),
  },
  (t) => [
    uniqueIndex('transfer_download_points_key_idx').on(t.trackedDownloadId, t.resolution, t.time),
    index('transfer_download_points_time_idx').on(t.resolution, t.time),
  ],
);

/** Built-in engine totals. */
export const transferEnginePoints = sqliteTable(
  'transfer_engine_points',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    resolution: text('resolution').$type<MetricResolution>().notNull(),
    time: text('time').notNull(),
    samples: integer('samples').notNull(),
    downloadRate: real('download_rate').notNull(),
    uploadRate: real('upload_rate').notNull(),
    peers: real('peers').notNull(),
    activeTorrents: real('active_torrents').notNull(),
  },
  (t) => [uniqueIndex('transfer_engine_points_key_idx').on(t.resolution, t.time)],
);

/** VPN state as shares of samples (0..1) while the VPN is enabled. */
export const vpnMetricPoints = sqliteTable(
  'vpn_metric_points',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    resolution: text('resolution').$type<MetricResolution>().notNull(),
    time: text('time').notNull(),
    samples: integer('samples').notNull(),
    connected: real('connected').notNull(),
    killSwitch: real('kill_switch').notNull(),
    warning: real('warning').notNull(),
    /** Forwarded port at the end of the bucket. */
    forwardedPort: integer('forwarded_port'),
  },
  (t) => [uniqueIndex('vpn_metric_points_key_idx').on(t.resolution, t.time)],
);

/** VPN transitions (connect/disconnect, kill switch, forwarded port, warnings); kept 90 days. */
export const vpnMetricEvents = sqliteTable(
  'vpn_metric_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    time: text('time').notNull(),
    type: text('type').$type<VpnMetricEventType>().notNull(),
    message: text('message'),
    port: integer('port'),
  },
  (t) => [index('vpn_metric_events_time_idx').on(t.time)],
);

export type TransferDownloadPointRow = typeof transferDownloadPoints.$inferSelect;
export type TransferEnginePointRow = typeof transferEnginePoints.$inferSelect;
export type VpnMetricPointRow = typeof vpnMetricPoints.$inferSelect;
export type VpnMetricEventRow = typeof vpnMetricEvents.$inferSelect;
