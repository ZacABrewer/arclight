import { z } from 'zod';
import { AnyMediaType, MediaType } from './library.js';
import { ReleaseProtocol } from './profiles.js';

// Download client settings, remote path mappings and the queue contract.

// ---------------------------------------------------------------------------------------
// Download clients
// ---------------------------------------------------------------------------------------

/**
 * Implementations Arclight can drive. Extend the enum, `DOWNLOAD_CLIENT_PROTOCOLS`, the
 * settings schema map and the unions below together. `builtin` is Arclight's own in-process
 * torrent engine (engine-wide settings live in the `torrent` settings section).
 */
// Order is the order clients are offered in: the built-in engine first (the default), then the
// remote engine and the external clients.
export const DownloadClientImplementation = z.enum([
  'builtin',
  'remoteEngine',
  'qbittorrent',
  'transmission',
  'deluge',
  'rtorrent',
  'sabnzbd',
  'nzbget',
]);
export type DownloadClientImplementation = z.infer<typeof DownloadClientImplementation>;

/** The protocol each implementation downloads; a client's `protocol` is always derived from this. */
export const DOWNLOAD_CLIENT_PROTOCOLS: Readonly<Record<DownloadClientImplementation, ReleaseProtocol>> = {
  qbittorrent: 'torrent',
  transmission: 'torrent',
  deluge: 'torrent',
  rtorrent: 'torrent',
  sabnzbd: 'usenet',
  nzbget: 'usenet',
  builtin: 'torrent',
  remoteEngine: 'torrent',
};

/**
 * Write-only secrets are never returned. Reads carry this mask instead; sending the mask
 * back on update keeps the stored value.
 */
export const PASSWORD_MASK = '********';

/** Settings keys that hold secrets (masked on read, kept when the mask is sent back). */
export const DOWNLOAD_CLIENT_SECRET_FIELDS = ['password', 'apiKey', 'token'] as const;

// ---- settings schemas ------------------------------------------------------------------
// These mirror the schemas in @arclight/download-clients (which `shared` cannot depend on).
// The api checks at compile time and at startup that both stay in sync. Every field carries a
// `.describe()` text: the api turns them into the settings form's help texts.

const hostField = z.string().trim().min(1).describe('Hostname or IP address of the download client.');
const portField = (defaultPort: number) =>
  z.number().int().min(1).max(65535).default(defaultPort).describe("Port the client's web interface or API listens on.");
const useSslField = z.boolean().default(false).describe('Connect over HTTPS.');
const urlBaseField = (example: string) =>
  z
    .string()
    .trim()
    .optional()
    .describe(`Path prefix when the client sits behind a reverse proxy or uses a non-default RPC path, e.g. "${example}".`);
const usernameField = z.string().default('').describe('Username, if the client requires authentication.');
const passwordField = z.string().default('').describe('Password. Write-only: never returned by the API.');
const categoryField = (noun: string) =>
  z
    .string()
    .trim()
    .default('arclight')
    .describe(`${noun} Arclight assigns to its downloads, keeping them apart from everything else. Leave empty to not use one.`);
const postImportCategoryField = (noun: string) =>
  z
    .string()
    .trim()
    .optional()
    .describe(`${noun} to move a download to after Arclight has imported it. Leave empty to keep it unchanged.`);
const addPausedField = z.boolean().default(false).describe('Add downloads in a paused state.');

export const QBittorrentPriority = z.enum(['last', 'first']);
export const QBittorrentInitialState = z.enum(['start', 'pause', 'forceStart']);
export const QBittorrentContentLayout = z.enum(['default', 'original', 'subfolder', 'noSubfolder']);

export const QBittorrentClientSettings = z.object({
  host: z.string().trim().min(1).describe('Hostname or IP address of qBittorrent.'),
  port: z.number().int().min(1).max(65535).default(8080).describe('qBittorrent WebUI port.'),
  useSsl: z.boolean().default(false).describe('Connect to the WebUI over HTTPS.'),
  urlBase: z
    .string()
    .trim()
    .optional()
    .describe('Prefix added to the WebUI URL when qBittorrent sits behind a reverse proxy, e.g. /qbittorrent.'),
  username: z.string().default('').describe('WebUI username. Leave empty when authentication is bypassed.'),
  password: z.string().default('').describe('WebUI password. Never shown after saving.'),
  category: z
    .string()
    .trim()
    .default('arclight')
    .describe(
      'Category Arclight adds its torrents with. Only torrents in this category are tracked; using a dedicated category is strongly recommended.',
    ),
  postImportCategory: z
    .string()
    .trim()
    .optional()
    .describe('Category to move torrents to after they are imported. Leave empty to keep the original category.'),
  recentPriority: QBittorrentPriority.default('last').describe('Queue position for content released within the last 14 days.'),
  olderPriority: QBittorrentPriority.default('last').describe('Queue position for content released more than 14 days ago.'),
  initialState: QBittorrentInitialState.default('start').describe(
    'State of torrents when they are added. Force Started ignores qBittorrent queue limits.',
  ),
  sequentialOrder: z.boolean().default(false).describe('Download pieces in order (qBittorrent 4.1.0+).'),
  firstAndLast: z.boolean().default(false).describe('Download the first and last pieces first (qBittorrent 4.1.0+).'),
  contentLayout: QBittorrentContentLayout.default('default').describe(
    "Whether to use qBittorrent's configured content layout, the torrent's original layout, or always create a subfolder (qBittorrent 4.3.2+).",
  ),
});
export type QBittorrentClientSettings = z.infer<typeof QBittorrentClientSettings>;

export const TransmissionPriority = z.enum(['last', 'first']);

export const TransmissionClientSettings = z.object({
  host: hostField,
  port: portField(9091),
  useSsl: useSslField,
  urlBase: z
    .string()
    .trim()
    .default('/transmission/')
    .describe(
      'RPC path prefix; "rpc" is appended. Transmission\'s default is "/transmission/". Change it only behind a reverse proxy or when rpc-url was customised.',
    ),
  username: usernameField,
  password: passwordField,
  category: categoryField('Label'),
  postImportCategory: postImportCategoryField('Label'),
  directory: z
    .string()
    .trim()
    .optional()
    .describe("Download directory as Transmission sees it. Leave empty to use Transmission's default download-dir."),
  recentPriority: TransmissionPriority.default('last').describe(
    'Queue position for recently released content: "first" moves it to the top of the download queue.',
  ),
  olderPriority: TransmissionPriority.default('last').describe(
    'Queue position for older content: "first" moves it to the top of the download queue.',
  ),
  addPaused: addPausedField,
});
export type TransmissionClientSettings = z.infer<typeof TransmissionClientSettings>;

const DELUGE_LABEL_PATTERN = /^[a-z0-9_.-]*$/;
const isValidDelugeLabel = (value: string | undefined) =>
  value === undefined || DELUGE_LABEL_PATTERN.test(value.trim().toLowerCase());
const DELUGE_LABEL_RULE = 'Deluge labels may only contain letters, digits, "_", "-" and "." (they are stored lowercase).';

export const DelugePriority = z.enum(['last', 'first']);

export const DelugeClientSettings = z.object({
  host: hostField,
  port: portField(8112),
  useSsl: useSslField,
  urlBase: urlBaseField('/deluge'),
  password: passwordField.describe(
    'Deluge Web UI password (Deluge has no username). A fresh Deluge install uses "deluge" until it is changed. Write-only: never returned by the API.',
  ),
  category: categoryField('Label')
    .describe(
      "Label Arclight assigns to its downloads via Deluge's Label plugin (enabled automatically when needed), keeping them apart from everything else. Converted to lowercase. Leave empty to not use one.",
    )
    .refine(isValidDelugeLabel, DELUGE_LABEL_RULE),
  postImportCategory: postImportCategoryField('Label').refine(isValidDelugeLabel, DELUGE_LABEL_RULE),
  recentPriority: DelugePriority.default('last').describe(
    'Queue position for recently released content: "first" moves it to the top of Deluge\'s queue.',
  ),
  olderPriority: DelugePriority.default('last').describe(
    'Queue position for older content: "first" moves it to the top of Deluge\'s queue.',
  ),
  addPaused: addPausedField,
});
export type DelugeClientSettings = z.infer<typeof DelugeClientSettings>;

export const RTorrentPriority = z.enum(['off', 'low', 'normal', 'high']);

export const RTorrentClientSettings = z.object({
  host: hostField,
  port: portField(8080),
  useSsl: useSslField,
  urlBase: z
    .string()
    .trim()
    .default('RPC2')
    .describe(
      'Path of the XML-RPC endpoint the web server (SCGI bridge) exposes, e.g. "RPC2", or "plugins/rpc/rpc.php" for ruTorrent\'s rpc plugin.',
    ),
  username: usernameField,
  password: passwordField,
  category: categoryField('Label (stored in d.custom1, the ruTorrent label)'),
  postImportCategory: postImportCategoryField('Label'),
  directory: z
    .string()
    .trim()
    .optional()
    .describe("Directory rTorrent saves Arclight downloads into. Leave empty to use rTorrent's default directory."),
  addPaused: addPausedField,
  recentPriority: RTorrentPriority.default('normal').describe('rTorrent priority for content released recently.'),
  olderPriority: RTorrentPriority.default('normal').describe('rTorrent priority for older content.'),
});
export type RTorrentClientSettings = z.infer<typeof RTorrentClientSettings>;

export const SabnzbdPriority = z.enum(['default', 'paused', 'low', 'normal', 'high', 'force']);

export const SabnzbdClientSettings = z.object({
  host: hostField,
  port: portField(8080),
  useSsl: useSslField,
  urlBase: urlBaseField('/sabnzbd'),
  apiKey: z
    .string()
    .trim()
    .default('')
    .describe('Full API key from SABnzbd Config > General (not the NZB key). Preferred over username and password. Write-only: never returned by the API.'),
  username: usernameField.describe('Legacy: SABnzbd web login username, sent as ma_username. Only needed when no API key is set.'),
  password: passwordField.describe('Legacy: SABnzbd web login password, sent as ma_password. Write-only: never returned by the API.'),
  category: categoryField('SABnzbd category'),
  postImportCategory: postImportCategoryField('SABnzbd category'),
  recentPriority: SabnzbdPriority.default('default').describe(
    'Queue priority for releases that aired or were released recently. "default" uses the category\'s priority.',
  ),
  olderPriority: SabnzbdPriority.default('default').describe(
    'Queue priority for older releases. "default" uses the category\'s priority.',
  ),
});
export type SabnzbdClientSettings = z.infer<typeof SabnzbdClientSettings>;

export const NzbgetPriority = z.enum(['veryLow', 'low', 'normal', 'high', 'veryHigh', 'force']);
const nzbgetPriorityField = (when: string) =>
  NzbgetPriority.default('normal').describe(
    `NZBGet queue priority for ${when}: veryLow (-100), low (-50), normal (0), high (50), veryHigh (100) or force (900, ignores pause).`,
  );

export const NzbgetClientSettings = z.object({
  host: hostField,
  port: portField(6789),
  useSsl: useSslField,
  urlBase: urlBaseField('/nzbget'),
  username: z.string().default('nzbget').describe('NZBGet ControlUsername (Settings > Security).'),
  password: passwordField,
  category: categoryField('NZBGet category'),
  postImportCategory: postImportCategoryField('NZBGet category'),
  recentPriority: nzbgetPriorityField('releases that aired or were released recently'),
  olderPriority: nzbgetPriorityField('older releases'),
  addPaused: addPausedField,
});
export type NzbgetClientSettings = z.infer<typeof NzbgetClientSettings>;

export const BuiltinInitialState = z.enum(['start', 'pause']);

export const BuiltinCategoryPath = z.object({
  name: z.string().trim().min(1).describe('Category name.'),
  savePath: z.string().trim().min(1).describe('Folder downloads of this category are saved to.'),
});
export type BuiltinCategoryPath = z.infer<typeof BuiltinCategoryPath>;

export const BuiltinClientSettings = z.object({
  category: categoryField('Category'),
  postImportCategory: postImportCategoryField('Category'),
  savePath: z
    .string()
    .trim()
    .default('')
    .describe(
      'Root download folder. Downloads go to <root>/<category> unless the category has its own folder below. Leave empty to use the engine downloads folder (Settings > Torrent Engine).',
    ),
  categories: z
    .array(BuiltinCategoryPath)
    .default([])
    .describe('Per-category download folders. Categories without an entry use <root>/<category>.'),
  initialState: BuiltinInitialState.default('start').describe('State of torrents when they are added.'),
  seedRatioLimit: z
    .number()
    .min(0)
    .optional()
    .describe('Stop seeding once this share ratio is reached. Leave empty to use the engine default.'),
  seedTimeLimitMinutes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Stop seeding after this many minutes. Leave empty to use the engine default.'),
  superSeeding: z
    .boolean()
    .optional()
    .describe('Turn on super-seeding (BEP 16) for new torrents: while seeding, each peer is offered one piece at a time.'),
  uploadLimitKbps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Upload limit per torrent in KiB/s for new torrents. Leave empty or 0 for unlimited.'),
  downloadLimitKbps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Download limit per torrent in KiB/s for new torrents. Leave empty or 0 for unlimited.'),
  peerUploadLimitKbps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Upload limit per peer connection in KiB/s for new torrents. Leave empty or 0 for unlimited.'),
  peerDownloadLimitKbps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Download limit per peer connection in KiB/s for new torrents. Leave empty or 0 for unlimited.'),
});
export type BuiltinClientSettings = z.infer<typeof BuiltinClientSettings>;

/**
 * Arclight's torrent engine on another machine: the standalone engine agent (docker/Dockerfile.agent)
 * or another Arclight with the engine-agent module enabled. See docs/REMOTE-ENGINE.md.
 */
export const RemoteEngineClientSettings = z.object({
  url: z
    .string()
    .trim()
    .regex(/^https?:\/\/[^\s/]+/i, 'Enter an http:// or https:// URL')
    .describe(
      'Address of the engine agent, e.g. http://seedbox:7879, or http://other-arclight:7878/api/v1/engine-agent for another Arclight.',
    ),
  token: z
    .string()
    .default('')
    .describe("The agent's AGENT_TOKEN (or the other Arclight's API key). Write-only: never returned by the API."),
  category: categoryField('Category'),
  postImportCategory: postImportCategoryField('Category'),
  pullMode: z
    .boolean()
    .default(false)
    .describe(
      'Copy finished downloads from the agent over HTTP into the local download folder (resumable, SHA-256 verified) before importing. Off: the agent shares storage with Arclight; add a Remote Path Mapping when the paths differ.',
    ),
  localDownloadPath: z.string().trim().default('').describe('Pull mode: local folder finished downloads are copied into before import.'),
  bandwidthLimitKbps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Pull mode: limit for copying from the agent in KiB/s. Leave empty or 0 for unlimited.'),
  followVpnPort: z
    .boolean()
    .default(false)
    .describe(
      "Apply this Arclight's VPN forwarded port to the agent's listener. Only for an agent behind the same VPN connection; an agent with its own VPN follows its own forwarded port (AGENT_PORT_FILE).",
    ),
});
export type RemoteEngineClientSettings = z.infer<typeof RemoteEngineClientSettings>;

/** Settings schema per implementation (validation and settings-form rendering). */
export const downloadClientSettingsSchemas = {
  qbittorrent: QBittorrentClientSettings,
  transmission: TransmissionClientSettings,
  deluge: DelugeClientSettings,
  rtorrent: RTorrentClientSettings,
  sabnzbd: SabnzbdClientSettings,
  nzbget: NzbgetClientSettings,
  builtin: BuiltinClientSettings,
  remoteEngine: RemoteEngineClientSettings,
} as const satisfies Record<DownloadClientImplementation, z.ZodObject>;

export type DownloadClientSettingsFor<K extends DownloadClientImplementation> = z.infer<(typeof downloadClientSettingsSchemas)[K]>;
/**
 * Settings of any implementation. Every remote variant has host, port, useSsl, password, ...;
 * `builtin` has no host (use `downloadClientHost()`). All variants have `category`.
 */
export type DownloadClientSettings = DownloadClientSettingsFor<DownloadClientImplementation>;

/**
 * The host remote path mappings key on: the configured host, the URL's host name for
 * `remoteEngine`, or "localhost" for `builtin`.
 */
export function downloadClientHost(settings: DownloadClientSettings | Readonly<Record<string, unknown>>): string {
  if ('host' in settings && typeof settings.host === 'string') return settings.host;
  if ('url' in settings && typeof settings.url === 'string') {
    try {
      return new URL(settings.url).hostname;
    } catch {
      return '';
    }
  }
  return 'localhost';
}

const downloadClientCommon = {
  name: z.string().trim().min(1).max(100),
  enable: z.boolean().default(true),
  /** Derived from the implementation when omitted. */
  protocol: ReleaseProtocol.optional(),
  /** 1 is the highest priority. */
  priority: z.number().int().min(1).max(50).default(1),
  removeCompletedDownloads: z.boolean().default(true),
  removeFailedDownloads: z.boolean().default(true),
  tags: z.array(z.number().int()).default([]),
};

/** One object variant per implementation: `extra` plus the implementation literal and settings. */
function variants<E extends z.ZodRawShape>(extra: E) {
  const v = <K extends DownloadClientImplementation>(kind: K) =>
    z.object({ ...extra, implementation: z.literal(kind), settings: downloadClientSettingsSchemas[kind] });
  return [v('qbittorrent'), v('transmission'), v('deluge'), v('rtorrent'), v('sabnzbd'), v('nzbget'), v('builtin'), v('remoteEngine')] as const;
}

/** Create/update body. One variant per implementation, discriminated on `implementation`. */
export const DownloadClientInput = z.discriminatedUnion('implementation', variants(downloadClientCommon));
export type DownloadClientInput = z.infer<typeof DownloadClientInput>;
export const DownloadClientCreate = DownloadClientInput;
export type DownloadClientCreate = DownloadClientInput;
export const DownloadClientUpdate = DownloadClientInput;
export type DownloadClientUpdate = DownloadClientInput;

export const DownloadClientResource = z.discriminatedUnion(
  'implementation',
  variants({ id: z.number().int(), ...downloadClientCommon, protocol: ReleaseProtocol }),
);
export type DownloadClientResource = z.infer<typeof DownloadClientResource>;

/** Body of POST /downloadclient/test: a candidate config, optionally of an existing row. */
export const DownloadClientTestRequest = z.discriminatedUnion(
  'implementation',
  variants({ id: z.number().int().optional(), ...downloadClientCommon }),
);
export type DownloadClientTestRequest = z.infer<typeof DownloadClientTestRequest>;

export const DownloadClientTestResult = z.object({
  ok: z.boolean(),
  version: z.string().optional(),
  apiVersion: z.string().optional(),
  warnings: z.array(z.string()),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type DownloadClientTestResult = z.infer<typeof DownloadClientTestResult>;

export const DownloadClientTestAllResult = z.array(
  DownloadClientTestResult.extend({ id: z.number().int(), name: z.string() }),
);
export type DownloadClientTestAllResult = z.infer<typeof DownloadClientTestAllResult>;

/** A field definition the UI renders for an implementation's settings form. */
export const DownloadClientField = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['text', 'number', 'password', 'checkbox', 'select']),
  helpText: z.string(),
  required: z.boolean(),
  advanced: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type DownloadClientField = z.infer<typeof DownloadClientField>;

export const DownloadClientImplementationSchema = z.object({
  implementation: DownloadClientImplementation,
  implementationName: z.string(),
  protocol: ReleaseProtocol,
  description: z.string(),
  infoLink: z.string().optional(),
  /** Fields of the common part (name, priority, ...) followed by implementation settings. */
  fields: z.array(DownloadClientField),
  /** A ready-to-edit template with every default filled in. */
  template: DownloadClientInput,
});
export type DownloadClientImplementationSchema = z.infer<typeof DownloadClientImplementationSchema>;

export const DownloadClientsErrorResponse = z.object({
  error: z.string(),
  code: z.string(),
});
export type DownloadClientsErrorResponse = z.infer<typeof DownloadClientsErrorResponse>;

// ---------------------------------------------------------------------------------------
// Remote path mappings
// ---------------------------------------------------------------------------------------

export const RemotePathMapping = z.object({
  id: z.number().int(),
  /** The download client's configured host this mapping applies to. */
  host: z.string(),
  /** Path prefix as the download client sees it (directory form). */
  remotePath: z.string(),
  /** The same directory as Arclight sees it (directory form). */
  localPath: z.string(),
});
export type RemotePathMapping = z.infer<typeof RemotePathMapping>;

export const RemotePathMappingInput = z.object({
  host: z.string().trim().min(1),
  remotePath: z.string().min(1),
  localPath: z.string().trim().min(1),
});
export type RemotePathMappingInput = z.infer<typeof RemotePathMappingInput>;

// ---------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------

export const TrackedDownloadState = z.enum([
  'pending',
  'downloading',
  'importPending',
  'importing',
  'imported',
  'failedPending',
  'failed',
  'ignored',
]);
export type TrackedDownloadState = z.infer<typeof TrackedDownloadState>;

/** States that are never shown in the queue and never re-processed. */
export const TERMINAL_TRACKED_STATES: readonly TrackedDownloadState[] = ['imported', 'failed', 'ignored'];

/** Status reported by the download client; `unknown` when it no longer reports the item. */
export const QueueItemClientStatus = z.enum([
  'queued',
  'downloading',
  'paused',
  'completed',
  'seeding',
  'failed',
  'warning',
  'unknown',
]);
export type QueueItemClientStatus = z.infer<typeof QueueItemClientStatus>;

export const TrackedDownloadStatus = z.enum(['ok', 'warning', 'error']);
export type TrackedDownloadStatus = z.infer<typeof TrackedDownloadStatus>;

export const QueueStatusMessage = z.object({
  title: z.string(),
  messages: z.array(z.string()),
});
export type QueueStatusMessage = z.infer<typeof QueueStatusMessage>;

/**
 * Why a queue item is (or is not) moving, as a machine code. `stateReason` carries the
 * human-readable sentence; the web localises its label from the code.
 */
export const QueueItemStateCode = z.enum([
  'downloading',
  'pendingGrab',
  'metadata',
  'checking',
  'moving',
  'queued',
  'paused',
  'killSwitch',
  'noPeers',
  'stalled',
  'diskSpace',
  /** Paused by Arclight: the download volume fell below the minimum free space. */
  'diskPaused',
  /** A grab held back (not sent to the client) until its download volume has room. */
  'diskHeld',
  'clientUnavailable',
  'missing',
  'warning',
  'error',
  'completed',
  'importPending',
  'importBlocked',
  'importing',
]);
export type QueueItemStateCode = z.infer<typeof QueueItemStateCode>;

/** How loudly the UI shows a state reason or timeline event. */
export const QueueSeverity = z.enum(['ok', 'info', 'warning', 'error']);
export type QueueSeverity = z.infer<typeof QueueSeverity>;

/**
 * Live transfer numbers. Every field but the rates is optional: the built-in engine fills all
 * of them, qBittorrent most, usenet clients only the rates (or omit the block).
 */
export const QueueItemLive = z.object({
  /** Bytes per second. */
  downloadRate: z.number(),
  uploadRate: z.number(),
  connectedPeers: z.number().int().optional(),
  connectedSeeds: z.number().int().optional(),
  /** Largest seeder/leecher counts trackers reported for the whole swarm. */
  swarmSeeds: z.number().int().optional(),
  swarmLeechers: z.number().int().optional(),
  piecesHave: z.number().int().optional(),
  pieceCount: z.number().int().optional(),
  ratio: z.number().optional(),
  /** Connected peers per transport. */
  transports: z.object({ tcp: z.number().int(), utp: z.number().int() }).optional(),
  /** Connected peers whose connection is encrypted. */
  encryptedPeers: z.number().int().optional(),
  /** This download's own limits in bytes/s (0 = unlimited), when the client reports them. */
  downloadLimit: z.number().int().optional(),
  uploadLimit: z.number().int().optional(),
  /** 1-based place in the client's download queue (absent once finished or when not queued). */
  queuePosition: z.number().int().optional(),
  /** Started past the client's active-download limit. */
  forceStart: z.boolean().optional(),
});
export type QueueItemLive = z.infer<typeof QueueItemLive>;

/** POST /queue/:id/limits: bytes/s, 0 = unlimited; omitted keys keep their value. */
export const QueueItemLimitsRequest = z.object({
  downloadLimit: z.number().int().min(0).optional(),
  uploadLimit: z.number().int().min(0).optional(),
});
export type QueueItemLimitsRequest = z.infer<typeof QueueItemLimitsRequest>;

export const QueueMove = z.enum(['top', 'up', 'down', 'bottom']);
export type QueueMove = z.infer<typeof QueueMove>;

/** POST /queue/:id/move */
export const QueueMoveRequest = z.object({ move: QueueMove });
export type QueueMoveRequest = z.infer<typeof QueueMoveRequest>;

/** POST /queue/:id/forcestart */
export const QueueForceStartRequest = z.object({ enabled: z.boolean() });
export type QueueForceStartRequest = z.infer<typeof QueueForceStartRequest>;

export const QueueItem = z.object({
  id: z.number().int(),
  /** Client-side id (info-hash for torrents). `pending:*` while not yet sent to a client. */
  downloadId: z.string(),
  downloadClientId: z.number().int().nullable(),
  downloadClientName: z.string().nullable(),
  title: z.string(),
  status: QueueItemClientStatus,
  trackedStatus: TrackedDownloadStatus,
  statusMessages: z.array(QueueStatusMessage),
  protocol: ReleaseProtocol,
  sizeBytes: z.number().int(),
  sizeLeftBytes: z.number().int(),
  /** 0..1 */
  progress: z.number(),
  /** Milliseconds remaining as of the last poll. */
  eta: z.number().int().optional(),
  /** Local path of the content, remote path mappings applied. */
  outputPath: z.string().optional(),
  added: z.string(),
  trackedState: TrackedDownloadState,
  mediaType: AnyMediaType.optional(),
  seriesId: z.number().int().optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
  /** Music grabs: the artist and the albums the release covers. */
  artistId: z.number().int().optional(),
  albumIds: z.array(z.number().int()).optional(),
  /** Audiobook grabs: the author and the books the release covers. */
  authorId: z.number().int().optional(),
  bookIds: z.array(z.number().int()).optional(),
  /** Why the item is (not) moving. Optional: older servers and some paths omit it. */
  stateCode: QueueItemStateCode.optional(),
  stateReason: z.string().optional(),
  stateSeverity: QueueSeverity.optional(),
  /** ISO-8601: when the download last received data, set while it counts as stalled. */
  stalledSince: z.string().optional(),
  live: QueueItemLive.optional(),
});
export type QueueItem = z.infer<typeof QueueItem>;

export const QueueSortKey = z.enum([
  'added',
  'title',
  'progress',
  'sizeBytes',
  'sizeLeftBytes',
  'status',
  'trackedState',
  'eta',
  'downloadClientName',
  'protocol',
]);
export type QueueSortKey = z.infer<typeof QueueSortKey>;

const queryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const QueueQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(20),
  sortKey: QueueSortKey.default('added'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  /** Include downloads that are not linked to a series or movie (not grabbed by Arclight). */
  includeUnknownMediaItems: queryBool.default(false),
  downloadClientId: z.coerce.number().int().optional(),
  protocol: ReleaseProtocol.optional(),
  trackedState: TrackedDownloadState.optional(),
  status: QueueItemClientStatus.optional(),
  mediaType: MediaType.optional(),
  seriesId: z.coerce.number().int().optional(),
  movieId: z.coerce.number().int().optional(),
});
export type QueueQuery = z.infer<typeof QueueQuery>;
export type QueueQueryInput = z.input<typeof QueueQuery>;

export const QueuePage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  sortKey: QueueSortKey,
  sortDirection: z.enum(['asc', 'desc']),
  totalRecords: z.number().int(),
  records: z.array(QueueItem),
});
export type QueuePage = z.infer<typeof QueuePage>;

/**
 * GET /queue/summary: one compact row per queue item linked to a library item, so library
 * pages can show "Queued", "Downloading 42%", "Importing" or "Failed" without the full queue.
 */
export const QueueSummaryItem = z.object({
  id: z.number().int(),
  mediaType: AnyMediaType.optional(),
  seriesId: z.number().int().optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
  trackedState: TrackedDownloadState,
  trackedStatus: TrackedDownloadStatus,
  status: QueueItemClientStatus,
  /** 0..1 */
  progress: z.number(),
  eta: z.number().int().optional(),
  stateCode: QueueItemStateCode.optional(),
  stateSeverity: QueueSeverity.optional(),
});
export type QueueSummaryItem = z.infer<typeof QueueSummaryItem>;

export const QueueStatus = z.object({
  /** Queue items linked to a series or movie. */
  totalCount: z.number().int(),
  /** Number of items (known or unknown) whose tracked status is error. */
  errors: z.number().int(),
  /** Number of items (known or unknown) whose tracked status is warning. */
  warnings: z.number().int(),
  /** Queue items not linked to any series or movie. */
  unknownCount: z.number().int(),
  /**
   * Disk-space guard: downloads Arclight paused because their volume fell below the minimum
   * free space, and grabs held back until there is room. Optional: older servers omit it.
   */
  diskGuard: z
    .object({
      paused: z.number().int(),
      held: z.number().int(),
      /** Download folders below the minimum, with their free bytes. */
      volumes: z.array(z.object({ path: z.string(), freeBytes: z.number().int() })),
      minimumFreeBytes: z.number().int(),
    })
    .optional(),
});
export type QueueStatus = z.infer<typeof QueueStatus>;

export const QueueRemoveOptions = z.object({
  removeFromClient: queryBool.default(true),
  blocklist: queryBool.default(false),
  skipRedownload: queryBool.default(false),
});
export type QueueRemoveOptions = z.infer<typeof QueueRemoveOptions>;

export const QueueBulkRemoveRequest = QueueRemoveOptions.extend({
  ids: z.array(z.number().int()).min(1),
});
export type QueueBulkRemoveRequest = z.infer<typeof QueueBulkRemoveRequest>;

export const QueueRemoveResult = z.object({
  removed: z.array(z.number().int()),
  failed: z.array(z.object({ id: z.number().int(), error: z.string() })),
});
export type QueueRemoveResult = z.infer<typeof QueueRemoveResult>;

/** POST /queue/:id/replace: give up on this release and search for another one. */
export const QueueReplaceRequest = z.object({
  /** Blocklist the release so the search does not pick it again. */
  blocklist: z.boolean().default(true),
  /** Delete the downloaded data along with the download. */
  removeData: z.boolean().default(true),
});
export type QueueReplaceRequest = z.infer<typeof QueueReplaceRequest>;
export type QueueReplaceRequestInput = z.input<typeof QueueReplaceRequest>;

export const QueueReplaceResult = z.object({
  /** The queue item that was replaced (now gone from the queue). */
  id: z.number().int(),
  blocklisted: z.boolean(),
  /** False when the item has no series/movie to search for. */
  searchStarted: z.boolean(),
  message: z.string(),
});
export type QueueReplaceResult = z.infer<typeof QueueReplaceResult>;

/** POST /queue/:id/reannounce */
export const QueueReannounceResult = z.object({
  id: z.number().int(),
  message: z.string(),
});
export type QueueReannounceResult = z.infer<typeof QueueReannounceResult>;

// ---------------------------------------------------------------------------------------
// Download timeline
// ---------------------------------------------------------------------------------------

/** What happened to a tracked download. Persisted, so only ever extend this list. */
export const DownloadEventType = z.enum([
  'pending',
  'grabbed',
  'metadataReceived',
  'started',
  'paused',
  'resumed',
  'stalled',
  'recovered',
  'completed',
  'importStarted',
  'importBlocked',
  'imported',
  'importFailed',
  'removed',
  'error',
  /** Asked the client for fresh peers (stall recovery step 1, or the Re-announce action). */
  'reannounced',
  /** Gave up on the release: removed (and usually blocklisted), searching for another one. */
  'replaced',
  /** Grab held back until the download volume has room (disk-space guard). */
  'held',
]);
export type DownloadEventType = z.infer<typeof DownloadEventType>;

export const DownloadEvent = z.object({
  id: z.number().int(),
  trackedDownloadId: z.number().int(),
  /** Client-side id (info-hash for torrents) at the time of the event. */
  downloadId: z.string(),
  title: z.string(),
  type: DownloadEventType,
  severity: QueueSeverity,
  /** ISO-8601 */
  time: z.string(),
  message: z.string().optional(),
  /** Small machine-readable extras, e.g. `{ reason: 'killSwitch' }` on a pause. */
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type DownloadEvent = z.infer<typeof DownloadEvent>;

/** GET /queue/:id/timeline: oldest first. Still served after the item left the queue. */
export const DownloadTimeline = z.object({
  trackedDownloadId: z.number().int(),
  events: z.array(DownloadEvent),
});
export type DownloadTimeline = z.infer<typeof DownloadTimeline>;
