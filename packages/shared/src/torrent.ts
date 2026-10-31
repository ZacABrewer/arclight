import { z } from 'zod';

// The built-in torrent engine: engine-wide settings (`torrent` settings section), live session
// status and the detailed torrent list behind /api/v1/torrent/*. Per-client options (category,
// save paths, initial state, seed limits per grab) live on the `builtin` download client row.

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

export const TorrentEncryptionMode = z.enum(['preferred', 'required', 'disabled']);
export type TorrentEncryptionMode = z.infer<typeof TorrentEncryptionMode>;

/** Engine defaults for the optional transport settings (mirrors the engine's own defaults). */
export const TORRENT_TRANSPORT_DEFAULTS = {
  encryption: 'preferred',
  tcp: true,
  utp: true,
  ipv6: true,
  webSeedConnectionsPerTorrent: 4,
} as const satisfies {
  encryption: TorrentEncryptionMode;
  tcp: boolean;
  utp: boolean;
  ipv6: boolean;
  webSeedConnectionsPerTorrent: number;
};

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
  tunnelGuard: z
    .boolean()
    .default(true)
    .describe('With the VPN on: slow the engine down automatically when the VPN tunnel starts to choke, so the tunnel stays up.'),
  diskGuard: z
    .boolean()
    .default(true)
    .describe(
      'Lower the download limit automatically to what the disk actually writes when received data piles up waiting for it, and raise it again once the disk keeps up.',
    ),
  maxActiveChecks: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(2)
    .describe('Torrents whose files are hashed at the same time (checks on add, re-checks, restores). The rest wait in queue order.'),
  metadataTimeoutMinutes: z
    .number()
    .int()
    .min(0)
    .max(10_080)
    .default(60)
    .describe('A magnet link that has not received its metadata after this many active minutes fails, so it can be replaced (0 = wait forever).'),
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
  // Optional so rows saved before these existed stay valid; the service fills the defaults
  // (encryption `preferred`, every transport on, 4 web seed connections) in its responses.
  encryption: TorrentEncryptionMode.optional().describe(
    'Peer connection encryption (MSE/PE). Preferred: try encrypted first, fall back to plaintext. Required: encrypted only. Disabled: plaintext only.',
  ),
  tcp: z.boolean().optional().describe('Accept and open TCP peer connections (default on).'),
  utp: z.boolean().optional().describe('Accept and open uTP peer connections on the UDP port (default on).'),
  ipv6: z.boolean().optional().describe('Also listen on IPv6 and use IPv6 peers when available (default on).'),
  webSeedConnectionsPerTorrent: z
    .number()
    .int()
    .min(0)
    .max(32)
    .optional()
    .describe('Concurrent HTTP requests to web seeds per torrent (default 4; 0 disables web seeds).'),
});
export type TorrentSettings = z.infer<typeof TorrentSettings>;

type WithoutDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;
type UpdateShape<S extends z.ZodRawShape> = { [K in keyof S]: z.ZodOptional<WithoutDefault<S[K]>> };

/**
 * Every key optional and without its default: `.partial()` alone would still fill the defaults
 * of omitted keys, so a partial update would reset them.
 */
function partialUpdate<S extends z.ZodRawShape>(schema: z.ZodObject<S>): z.ZodObject<UpdateShape<S>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const inner = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : (field as z.ZodType);
    shape[key] = inner.optional();
  }
  return z.object(shape) as unknown as z.ZodObject<UpdateShape<S>>;
}

/** PUT /settings/torrent: any subset; omitted keys keep their stored value. */
export const TorrentSettingsUpdate = partialUpdate(TorrentSettings);
export type TorrentSettingsUpdate = z.infer<typeof TorrentSettingsUpdate>;

export const TorrentSettingsResponse = TorrentSettings.extend({
  /** The folder actually used (the default when `downloadsRoot` is empty). */
  effectiveDownloadsRoot: z.string(),
  /** Fast-resume data and saved .torrent files (`<config>/torrents`). Not editable. */
  resumeDir: z.string(),
});
export type TorrentSettingsResponse = z.infer<typeof TorrentSettingsResponse>;

// ---------------------------------------------------------------------------------------
// Speed schedule and slow mode (`torrentSpeed` and `torrentSlowMode` settings sections)
// ---------------------------------------------------------------------------------------

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24-hour)');

/**
 * A weekly window in server-local time. `days` are the days the window starts on (0 = Sunday);
 * an `end` at or before `start` runs past midnight into the next day.
 */
export const SpeedScheduleRange = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1),
  start: ClockTime,
  end: ClockTime,
});
export type SpeedScheduleRange = z.infer<typeof SpeedScheduleRange>;

export const TorrentSpeedSettings = z.object({
  altDownloadLimitKbps: z
    .number()
    .int()
    .min(0)
    .default(1024)
    .describe('Global download limit in KiB/s while the alternative limits apply (0 = unlimited).'),
  altUploadLimitKbps: z
    .number()
    .int()
    .min(0)
    .default(256)
    .describe('Global upload limit in KiB/s while the alternative limits apply (0 = unlimited).'),
  scheduleEnabled: z.boolean().default(false).describe('Apply the alternative limits during the scheduled windows.'),
  schedule: z.array(SpeedScheduleRange).default([]).describe('Weekly windows in server-local time.'),
  mirrorToQbittorrent: z
    .boolean()
    .default(true)
    .describe("Switch qBittorrent's alternative speed limits on and off together with the engine's."),
});
export type TorrentSpeedSettings = z.infer<typeof TorrentSpeedSettings>;

/** PUT /settings/torrent/speed: any subset; omitted keys keep their stored value. */
export const TorrentSpeedSettingsUpdate = partialUpdate(TorrentSpeedSettings);
export type TorrentSpeedSettingsUpdate = z.infer<typeof TorrentSpeedSettingsUpdate>;

/** The manual slow-mode switch (persisted so it survives restarts). */
export const TorrentSlowModeState = z.object({
  enabled: z.boolean().default(false),
  /** ISO-8601: slow mode switches itself off at this time; null = until turned off. */
  until: z.string().nullable().default(null),
});
export type TorrentSlowModeState = z.infer<typeof TorrentSlowModeState>;

/** POST /torrent/slowmode */
export const TorrentSlowModeRequest = z.object({
  enabled: z.boolean(),
  /** ISO-8601 end time (only with enabled); omitted or null = until turned off. */
  until: z.string().datetime({ offset: true }).nullable().optional(),
});
export type TorrentSlowModeRequest = z.infer<typeof TorrentSlowModeRequest>;

/** Which limits the engine applies right now and why. */
export const TorrentSpeedMode = z.object({
  mode: z.enum(['normal', 'alternative']),
  /** Why the alternative limits apply (null in normal mode). Manual slow mode wins over the schedule. */
  reason: z.enum(['manual', 'schedule']).nullable(),
  slowMode: z.boolean(),
  /** ISO-8601 end of the manual slow mode, when it has one. */
  slowModeUntil: z.string().nullable(),
  /** ISO-8601: the next time the schedule switches modes (only while the schedule is on). */
  nextChange: z.string().optional(),
  /** Effective global limits in bytes/s (0 = unlimited). */
  downloadLimit: z.number().int(),
  uploadLimit: z.number().int(),
});
export type TorrentSpeedMode = z.infer<typeof TorrentSpeedMode>;

// ---------------------------------------------------------------------------------------
// Seeding rules (`seedingRules` settings section)
// ---------------------------------------------------------------------------------------

export const SeedingRuleAction = z.enum(['pause', 'remove']);
export type SeedingRuleAction = z.infer<typeof SeedingRuleAction>;

/**
 * What to do with finished torrents of the built-in engine. A rule matches when every
 * non-empty filter matches (any of its values); empty filters match everything. The first
 * enabled matching rule (list order) applies. It acts once the ratio or the seeding time is
 * reached (either one when both are set), never before a tracker's hit-and-run requirement
 * is met, and removes only downloads Arclight has imported.
 */
export const SeedingRule = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    /** Torrent categories (e.g. "tv", "movies"). */
    categories: z.array(z.string().trim().min(1)).default([]),
    /** Indexers the torrent was grabbed from (or whose trackers it announces to). */
    indexerIds: z.array(z.number().int()).default([]),
    /** Tracker host names; subdomains match too. */
    trackers: z.array(z.string().trim().toLowerCase().min(1)).default([]),
    ratio: z.number().min(0).nullable().default(null),
    seedTimeMinutes: z.number().int().min(0).nullable().default(null),
    action: SeedingRuleAction.default('pause'),
    /** With `remove`: delete the download folder copy too (never the library copy). */
    deleteFiles: z.boolean().default(false),
  })
  .refine((r) => r.ratio !== null || r.seedTimeMinutes !== null, { message: 'Set a ratio, a seeding time or both.' });
export type SeedingRule = z.infer<typeof SeedingRule>;
export type SeedingRuleInput = z.input<typeof SeedingRule>;

export const SeedingRulesSettings = z.object({ rules: z.array(SeedingRule).default([]) });
export type SeedingRulesSettings = z.infer<typeof SeedingRulesSettings>;
export type SeedingRulesSettingsInput = z.input<typeof SeedingRulesSettings>;

/** POST /torrent/seedingrules/apply: what one pass did (info-hashes). Null while the engine is not running. */
export const SeedingRulesRunResult = z
  .object({
    checked: z.number().int(),
    paused: z.array(z.string()),
    removed: z.array(z.string()),
    /** Torrents a rule wanted to act on but that were held back (hit-and-run, not imported). */
    held: z.array(z.object({ infoHash: z.string(), reason: z.string() })),
  })
  .nullable();
export type SeedingRulesRunResult = z.infer<typeof SeedingRulesRunResult>;

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
  /** Running, but with a caveat (e.g. listening on a fallback port). */
  warning: z.string().optional(),
  /** ARCLIGHT_TORRENT_ENGINE=0: the engine is not started at boot (only by enabling it). */
  bootBlocked: z.boolean().optional(),
  /** Present while the tunnel guard limits the engine (bytes/s; null = that direction not limited). */
  tunnelGuard: z.object({ downloadLimit: z.number().nullable(), uploadLimit: z.number().nullable(), connectionLimit: z.number().nullable().optional() }).optional(),
  /**
   * Present while the engine runs with the disk guard on. `downloadLimit` (bytes/s) is set while
   * the guard holds downloads to what the disk writes; null = not limiting. `writeRate` is the
   * measured disk write throughput (bytes/s), `backlogBytes` the received data waiting for disk.
   */
  diskGuard: z
    .object({
      downloadLimit: z.number().nullable(),
      writeRate: z.number(),
      backlogBytes: z.number(),
      backlogLimitBytes: z.number().optional(),
      /** Full data checks running and waiting for a slot. */
      checksActive: z.number().int().optional(),
      checksQueued: z.number().int().optional(),
    })
    .optional(),
  /** The configured connection and queue limits (the debug report shows them next to the counts). */
  limits: z
    .object({ maxConnections: z.number().int(), maxConnectionsPerTorrent: z.number().int(), maxActiveDownloads: z.number().int(), maxActiveSeeds: z.number().int() })
    .optional(),
  lockdownReason: z.string().optional(),
  /** ISO-8601: when the current lockdown started. */
  lockdownSince: z.string().optional(),
  /** Times the engine entered lockdown during the last hour (kill-switch flapping). */
  lockdownsLastHour: z.number().int().optional(),
  /** Torrents currently paused by the kill switch (resumed on reconnect). */
  killSwitchPaused: z.number().int().optional(),
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
  /** IPv6 DHT routing table size (0 when IPv6 is off). */
  dht6Nodes: z.number().int().optional(),
  /** Open uTP connections (including ones still handshaking). */
  utpConnections: z.number().int().optional(),
  /** Connected peers whose connection is RC4-encrypted (MSE). */
  encryptedPeers: z.number().int().optional(),
  /** encryptedPeers / peers (0 without peers). */
  encryptedPeerRatio: z.number().min(0).max(1).optional(),
  /** Connected peers across all torrents. */
  peers: z.number().int(),
  /** Bytes per second. */
  downloadRate: z.number(),
  uploadRate: z.number(),
  torrents: TorrentCounts,
  /** Normal or alternative ("slow mode") limits. Optional: older servers omit it. */
  speed: TorrentSpeedMode.optional(),
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
  /** The connection is RC4-encrypted (MSE). */
  encrypted: z.boolean().optional(),
  transport: z.enum(['tcp', 'utp']).optional(),
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

export const TorrentWebSeed = z.object({
  url: z.string(),
  /** Bytes per second. */
  downloadRate: z.number(),
  downloaded: z.number().int(),
  activeRequests: z.number().int(),
  failures: z.number().int(),
  /** ISO-8601; set while backing off after errors. */
  retryAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type TorrentWebSeed = z.infer<typeof TorrentWebSeed>;

/** Per-torrent and per-peer rate limits in bytes per second (0 = unlimited). */
export const TorrentLimits = z.object({
  uploadLimit: z.number().int().min(0),
  downloadLimit: z.number().int().min(0),
  peerUploadLimit: z.number().int().min(0),
  peerDownloadLimit: z.number().int().min(0),
});
export type TorrentLimits = z.infer<typeof TorrentLimits>;

/** POST /torrent/:id/limits: any subset; omitted keys keep their value. */
export const TorrentLimitsRequest = TorrentLimits.partial();
export type TorrentLimitsRequest = z.infer<typeof TorrentLimitsRequest>;

/** POST /torrent/:id/superseed */
export const TorrentSuperSeedRequest = z.object({ enabled: z.boolean() });
export type TorrentSuperSeedRequest = z.infer<typeof TorrentSuperSeedRequest>;

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
  /** BEP 19 web seeds (empty while none are active). */
  webSeeds: z.array(TorrentWebSeed).optional(),
  /** BEP 16 super-seeding. */
  superSeeding: z.boolean().optional(),
  limits: TorrentLimits.optional(),
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
