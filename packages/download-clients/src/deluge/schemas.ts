/**
 * Zod shapes of the Deluge Web UI JSON-RPC responses Arclight reads. Only the fields we
 * use are declared; everything else is stripped.
 */
import { z } from 'zod';

export const DelugeRpcErrorShape = z.object({
  message: z.string().default(''),
  code: z.number(),
});
export type DelugeRpcErrorShape = z.infer<typeof DelugeRpcErrorShape>;

export const DelugeEnvelope = z.object({
  result: z.unknown().optional(),
  error: DelugeRpcErrorShape.nullable().optional(),
  id: z.union([z.number(), z.string()]).nullable().optional(),
});
export type DelugeEnvelope = z.infer<typeof DelugeEnvelope>;

export const DelugeBoolean = z.boolean();
export const DelugeStringList = z.array(z.string());
/** `web.get_hosts`: Deluge 2 rows are [id, host, port, username]; 1.3 rows are [id, host, port, status]. */
export const DelugeHosts = z.array(z.array(z.unknown()));
/** `web.get_host_status`: Deluge 2 [id, status, version]; 1.3 [id, host, port, status, version]. */
export const DelugeHostStatus = z.array(z.unknown()).nullable();
/** `core.add_torrent_*`: the info-hash, or null when Deluge refused the torrent. */
export const DelugeAddResult = z.string().nullable();
export const DelugeVersion = z.string();
export const DelugePort = z.number().int();
export const DelugeAny = z.unknown();

export const DelugeTorrentStatus = z.object({
  hash: z.string().optional(),
  name: z.string().default(''),
  state: z.string().default(''),
  /** Percent, 0..100. */
  progress: z.number().default(0),
  eta: z.number().optional(),
  message: z.string().optional(),
  is_finished: z.boolean().default(false),
  /** Deluge 1.3 name of the save directory. */
  save_path: z.string().optional(),
  /** Deluge 2 name of the save directory. */
  download_location: z.string().optional(),
  total_size: z.number().default(0),
  total_done: z.number().default(0),
  total_wanted: z.number().optional(),
  ratio: z.number().default(0),
  stop_at_ratio: z.boolean().optional(),
  stop_ratio: z.number().optional(),
  remove_at_ratio: z.boolean().optional(),
  is_auto_managed: z.boolean().optional(),
  seeding_time: z.number().optional(),
  label: z.string().optional(),
  num_files: z.number().optional(),
  time_added: z.number().optional(),
});
export type DelugeTorrentStatus = z.infer<typeof DelugeTorrentStatus>;

/** `core.get_torrents_status`: an object keyed by info-hash. */
export const DelugeTorrentMap = z.record(z.string(), DelugeTorrentStatus);
export type DelugeTorrentMap = z.infer<typeof DelugeTorrentMap>;

export const DelugeConfigValues = z.object({
  stop_seed_at_ratio: z.boolean().optional(),
  stop_seed_ratio: z.number().optional(),
  remove_seed_at_ratio: z.boolean().optional(),
  download_location: z.string().optional(),
  move_completed: z.boolean().optional(),
  move_completed_path: z.string().optional(),
});
export type DelugeConfigValues = z.infer<typeof DelugeConfigValues>;

export const DELUGE_CONFIG_KEYS = [
  'stop_seed_at_ratio',
  'stop_seed_ratio',
  'remove_seed_at_ratio',
  'download_location',
  'move_completed',
  'move_completed_path',
] as const;

/** `label.get_options`: per-label settings, of which only the move-completed path matters. */
export const DelugeLabelOptions = z.object({
  apply_move_completed: z.boolean().optional(),
  move_completed: z.boolean().optional(),
  move_completed_path: z.string().optional(),
});
export type DelugeLabelOptions = z.infer<typeof DelugeLabelOptions>;

export const DELUGE_TORRENT_FIELDS = [
  'hash',
  'name',
  'state',
  'progress',
  'eta',
  'message',
  'is_finished',
  'save_path',
  'download_location',
  'total_size',
  'total_done',
  'total_wanted',
  'ratio',
  'stop_at_ratio',
  'stop_ratio',
  'remove_at_ratio',
  'is_auto_managed',
  'seeding_time',
  'label',
  'num_files',
  'time_added',
] as const;
