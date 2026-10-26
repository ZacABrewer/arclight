import { z } from 'zod';

/**
 * Shapes of the qBittorrent WebUI API v2 responses we consume. Only the fields we read are
 * declared; unknown fields are stripped. Fields that appeared in later API versions are
 * optional so older clients still parse.
 */

export const QbtTorrent = z.object({
  hash: z.string(),
  name: z.string(),
  /** Bytes selected for download. */
  size: z.number(),
  /** 0..1 */
  progress: z.number(),
  /** Seconds; 8640000 means "unknown/infinite". */
  eta: z.number(),
  state: z.string(),
  category: z.string().optional(),
  save_path: z.string(),
  /** API 2.6.1+ (qBittorrent 4.3.2+). Root file or folder of the content. */
  content_path: z.string().optional(),
  /** Bytes still to download, when reported. */
  amount_left: z.number().optional(),
  ratio: z.number(),
  /** -2 = use global limit, -1 = no limit. */
  ratio_limit: z.number().optional(),
  /** Seconds. Reported by torrents/info on newer versions only. */
  seeding_time: z.number().optional(),
  /** Minutes. -2 = use global limit, -1 = no limit. */
  seeding_time_limit: z.number().optional(),
  /** Minutes. -2 = use global limit, -1 = no limit. API 2.9.2+. */
  inactive_seeding_time_limit: z.number().optional(),
  /** Unix seconds of the last piece transfer. */
  last_activity: z.number().optional(),
  /** qBittorrent 5.x reports this in torrents/info. */
  private: z.boolean().optional(),
});
export type QbtTorrent = z.infer<typeof QbtTorrent>;

export const QbtTorrentList = z.array(QbtTorrent);

export const QbtProperties = z.object({
  save_path: z.string(),
  /** Seconds. */
  seeding_time: z.number().optional(),
  /** qBittorrent 4.6+. */
  is_private: z.boolean().optional(),
});
export type QbtProperties = z.infer<typeof QbtProperties>;

export const QbtFileList = z.array(z.object({ name: z.string() }));

/** max_ratio_act: 0 pause/stop, 1 remove, 2 super seeding, 3 remove with files. */
export const QBT_RATIO_ACTION_REMOVE = 1;
export const QBT_RATIO_ACTION_DELETE_FILES = 3;

export const QbtPreferences = z.object({
  save_path: z.string(),
  /** Default torrent management mode is automatic: category paths apply. */
  auto_tmm_enabled: z.boolean().optional(),
  max_ratio_enabled: z.boolean().optional(),
  max_ratio: z.number().optional(),
  max_seeding_time_enabled: z.boolean().optional(),
  /** Minutes. */
  max_seeding_time: z.number().optional(),
  max_inactive_seeding_time_enabled: z.boolean().optional(),
  /** Minutes. */
  max_inactive_seeding_time: z.number().optional(),
  max_ratio_act: z.number().optional(),
  queueing_enabled: z.boolean().optional(),
  dht: z.boolean().optional(),
});
export type QbtPreferences = z.infer<typeof QbtPreferences>;

export const QbtCategories = z.record(
  z.string(),
  z.object({
    name: z.string(),
    savePath: z.string().optional(),
  }),
);
export type QbtCategories = z.infer<typeof QbtCategories>;
