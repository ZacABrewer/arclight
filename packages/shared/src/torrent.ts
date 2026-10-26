import { z } from 'zod';

// The built-in torrent engine: engine-wide settings (`torrent` settings section), live session
// status and the detailed torrent list behind /api/v1/torrent/*. Per-client options (category,
// save paths, initial state, seed limits per grab) live on the `builtin` download client row.

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

export const TorrentSettings = z.object({
  enabled: z.boolean().default(true).describe('Run the built-in torrent engine.'),
  autoRegisterClient: z
    .boolean()
    .default(true)
    .describe('On first start, add a "Built-in" download client when no download client exists.'),
  listenPort: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(6881)
    .describe('Port for incoming peer connections (TCP) and DHT (UDP). A port forwarded by the VPN takes precedence.'),
  maxConnections: z.number().int().min(1).max(5000).default(200).describe('Peer connections across all torrents.'),
  maxConnectionsPerTorrent: z.number().int().min(1).max(1000).default(50).describe('Peer connections per torrent.'),
  downloadLimitKbps: z.number().int().min(0).default(0).describe('Global download limit in KiB/s (0 = unlimited).'),
  uploadLimitKbps: z.number().int().min(0).default(0).describe('Global upload limit in KiB/s (0 = unlimited).'),
  dht: z.boolean().default(true).describe('Find peers through the distributed hash table (ignored by private torrents).'),
  pex: z.boolean().default(true).describe('Exchange peers with connected peers (ignored by private torrents).'),
  maxActiveDownloads: z.number().int().min(-1).default(3).describe('Torrents downloading at once (-1 = unlimited).'),
  maxActiveSeeds: z.number().int().min(-1).default(5).describe('Torrents seeding at once (-1 = unlimited).'),
  defaultSeedRatio: z.number().min(0).nullable().default(null).describe('Stop seeding at this ratio (empty = unlimited).'),
  defaultSeedTimeMinutes: z
    .number()
    .int()
    .min(0)
    .nullable()
    .default(null)
    .describe('Stop seeding after this many minutes (empty = unlimited).'),
  bindToVpn: z
    .boolean()
    .default(true)
    .describe(
      'When the VPN integration is enabled, bind every socket to the VPN tunnel and pause all torrents while it is down.',
    ),
  downloadsRoot: z
    .string()
    .trim()
    .default('')
    .describe('Default download folder. Empty = /downloads in Docker, otherwise a "downloads" folder next to the config folder.'),
});
export type TorrentSettings = z.infer<typeof TorrentSettings>;

/** PUT /settings/torrent: any subset; omitted keys keep their stored value. */
export const TorrentSettingsUpdate = TorrentSettings.partial();
export type TorrentSettingsUpdate = z.infer<typeof TorrentSettingsUpdate>;

export const TorrentSettingsResponse = TorrentSettings.extend({
  /** The folder actually used (the default when `downloadsRoot` is empty). */
  effectiveDownloadsRoot: z.string(),
  /** Fast-resume data and saved .torrent files (`<config>/torrents`). Not editable. */
  resumeDir: z.string(),
});
export type TorrentSettingsResponse = z.infer<typeof TorrentSettingsResponse>;

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

/**
 * `lockdown`: the VPN is enabled with bindToVpn but down (kill switch); every torrent is
 * paused and the sockets are bound to 127.0.0.1 until it reconnects.
 */
export const TorrentEngineState = z.enum(['disabled', 'starting', 'running', 'lockdown', 'error']);
export type TorrentEngineState = z.infer<typeof TorrentEngineState>;

export const TorrentCounts = z.object({
  total: z.number().int(),
  downloading: z.number().int(),
  seeding: z.number().int(),
  paused: z.number().int(),
  queued: z.number().int(),
  checking: z.number().int(),
  error: z.number().int(),
});
export type TorrentCounts = z.infer<typeof TorrentCounts>;

export const TorrentSessionStatus = z.object({
  enabled: z.boolean(),
  state: TorrentEngineState,
  error: z.string().optional(),
  lockdownReason: z.string().optional(),
  /** The port actually bound (null while stopped). */
  listenPort: z.number().int().nullable(),
  /** The port from settings; differs from `listenPort` when the VPN forwards another one. */
  configuredListenPort: z.number().int(),
  /** Address every socket is bound to; null = all interfaces. */
  boundAddress: z.string().nullable(),
  vpn: z.object({
    bindToVpn: z.boolean(),
    enabled: z.boolean(),
    connected: z.boolean(),
    tunnelAddress: z.string().optional(),
    forwardedPort: z.number().int().optional(),
    killSwitchEngaged: z.boolean(),
  }),
  dhtNodes: z.number().int(),
  /** Connected peers across all torrents. */
  peers: z.number().int(),
  /** Bytes per second. */
  downloadRate: z.number(),
  uploadRate: z.number(),
  torrents: TorrentCounts,
});
export type TorrentSessionStatus = z.infer<typeof TorrentSessionStatus>;

// ---------------------------------------------------------------------------------------
// Torrent details
// ---------------------------------------------------------------------------------------

export const TorrentState = z.enum(['checking', 'downloadingMetadata', 'downloading', 'seeding', 'paused', 'queued', 'error']);
export type TorrentState = z.infer<typeof TorrentState>;

export const TorrentPeer = z.object({
  address: z.string(),
  client: z.string(),
  source: z.enum(['tracker', 'dht', 'pex', 'incoming', 'manual']),
  incoming: z.boolean(),
  /** 0..1 */
  progress: z.number(),
  downloadRate: z.number(),
  uploadRate: z.number(),
  amChoking: z.boolean(),
  amInterested: z.boolean(),
  peerChoking: z.boolean(),
  peerInterested: z.boolean(),
  snubbed: z.boolean(),
});
export type TorrentPeer = z.infer<typeof TorrentPeer>;

export const TorrentTracker = z.object({
  url: z.string(),
  tier: z.number().int(),
  state: z.enum(['notContacted', 'updating', 'working', 'error', 'disabled']),
  message: z.string().optional(),
  peers: z.number().int(),
  seeds: z.number().int().optional(),
  leechers: z.number().int().optional(),
  /** ISO-8601 */
  nextAnnounce: z.string().optional(),
});
export type TorrentTracker = z.infer<typeof TorrentTracker>;

export const TorrentFile = z.object({
  index: z.number().int(),
  path: z.string(),
  length: z.number().int(),
  /** 0 = skip, 1 = normal, up to 7 = highest. */
  priority: z.number().int(),
  /** 0..1 */
  progress: z.number(),
});
export type TorrentFile = z.infer<typeof TorrentFile>;

export const TorrentDetail = z.object({
  /** Lowercase v1 info-hash; equals the queue item's downloadId. */
  id: z.string(),
  name: z.string(),
  state: TorrentState,
  progress: z.number(),
  totalBytes: z.number().int(),
  wantedBytes: z.number().int(),
  bytesLeft: z.number().int(),
  downloaded: z.number().int(),
  uploaded: z.number().int(),
  downloadRate: z.number(),
  uploadRate: z.number(),
  etaSeconds: z.number().int().optional(),
  ratio: z.number(),
  connectedPeers: z.number().int(),
  connectedSeeds: z.number().int(),
  swarmSeeds: z.number().int(),
  swarmLeechers: z.number().int(),
  seedingTimeMs: z.number().int(),
  addedAt: z.string(),
  completedAt: z.string().nullable(),
  savePath: z.string(),
  contentPath: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  piecesHave: z.number().int(),
  pieceCount: z.number().int(),
  private: z.boolean(),
  sequential: z.boolean(),
  error: z.string().optional(),
  peers: z.array(TorrentPeer),
  trackers: z.array(TorrentTracker),
  files: z.array(TorrentFile),
});
export type TorrentDetail = z.infer<typeof TorrentDetail>;

export const TorrentListQuery = z.object({
  /** Only this info-hash (the queue drawer asks for one). */
  id: z.string().optional(),
  category: z.string().optional(),
});
export type TorrentListQuery = z.infer<typeof TorrentListQuery>;

export const TorrentMoveRequest = z.object({ savePath: z.string().trim().min(1) });
export type TorrentMoveRequest = z.infer<typeof TorrentMoveRequest>;

export const TorrentPriorityRequest = z.object({
  files: z.array(z.object({ index: z.number().int().min(0), priority: z.number().int().min(0).max(7) })).optional(),
  sequential: z.boolean().optional(),
});
export type TorrentPriorityRequest = z.infer<typeof TorrentPriorityRequest>;

export const TorrentActionResult = z.object({ ok: z.literal(true) });
export type TorrentActionResult = z.infer<typeof TorrentActionResult>;

export const TorrentErrorResponse = z.object({ error: z.string(), code: z.string() });
export type TorrentErrorResponse = z.infer<typeof TorrentErrorResponse>;
