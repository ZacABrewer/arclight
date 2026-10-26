/**
 * Client-agnostic contract between Arclight and an external download client.
 *
 * Every concrete client (qBittorrent, Transmission, Deluge, rTorrent, SABnzbd, NZBGet)
 * implements `DownloadClient` and reports its queue as normalized `DownloadItem`s so the
 * api's downloads module never needs to know which client it is talking to.
 */

export type DownloadItemStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'seeding'
  | 'failed'
  | 'warning';

/**
 * Live transfer numbers a client can report next to an item. Rates are required, the rest is
 * whatever the client knows (the built-in engine fills everything, qBittorrent most of it).
 */
export interface DownloadItemLive {
  /** Bytes per second. */
  downloadRate: number;
  uploadRate: number;
  connectedPeers?: number;
  connectedSeeds?: number;
  /** Largest seeder/leecher counts reported by trackers. */
  swarmSeeds?: number;
  swarmLeechers?: number;
  piecesHave?: number;
  pieceCount?: number;
  ratio?: number;
  /** Connected peers per transport. */
  transports?: { tcp: number; utp: number };
  encryptedPeers?: number;
}

/**
 * Finer phase than `status`, when the client tells: fetching the metadata of a magnet,
 * checking existing data, relocating files, or (client-reported) stalled for lack of peers.
 */
export type DownloadItemPhase = 'metadata' | 'checking' | 'moving' | 'stalled';

export interface DownloadItem {
  /** Client-side identifier. For torrent clients this is the lowercase v1 info-hash. */
  id: string;
  title: string;
  category: string;
  totalBytes: number;
  remainingBytes: number;
  downloadedBytes: number;
  /** 0..1 */
  progress: number;
  status: DownloadItemStatus;
  statusMessage?: string;
  /**
   * Where the finished content lives, as the download client sees it (no remote path
   * mapping applied). A directory for multi-file torrents, a file path for single-file ones.
   */
  outputPath: string;
  /** Undefined when the client does not know (stalled, queued, ...). 0 once finished. */
  etaSeconds?: number;
  /**
   * True when the payload must stay where it is because the client is still required to
   * seed it (seed ratio / time limits not yet met). Importers must copy or hardlink, never move.
   */
  isReadOnly: boolean;
  /** The importer may move the files out of the client's directory. */
  canMoveFiles: boolean;
  /** The item may be removed from the client without breaking seeding obligations. */
  canBeRemoved: boolean;
  live?: DownloadItemLive;
  phase?: DownloadItemPhase;
}

export interface AddTorrentInput {
  magnet?: string;
  torrentFile?: Uint8Array;
  title: string;
  category: string;
  savePath?: string;
  /** Overrides the client's configured initial state when set. */
  paused?: boolean;
  seedRatioLimit?: number;
  seedTimeLimitMinutes?: number;
  /**
   * Whether the content aired/released recently. Selects between the client's
   * `recentPriority` and `olderPriority` settings. Defaults to false (older).
   */
  isRecent?: boolean;
  /**
   * The payload is already complete at `savePath` (cross-seeding): skip the hash check and
   * seed right away. qBittorrent sends `skip_checking`; the built-in engine trusts the files
   * when their sizes match. Clients without the concept ignore it and check normally.
   */
  skipChecking?: boolean;
}

export interface AddTorrentResult {
  /** The id the item will have in `getItems()` (lowercase info-hash for torrents). */
  id: string;
  /** Follow-up steps (priority, force start, share limits) that could not be applied. */
  warnings: string[];
}

/** Which kind of release a client downloads. */
export type DownloadProtocol = 'torrent' | 'usenet';

export interface AddNzbInput {
  /** Raw NZB document. */
  nzb: Uint8Array;
  title: string;
  category: string;
  /**
   * Overrides the client's configured priority. When omitted the client picks its
   * `recentPriority` / `olderPriority` setting from `isRecent`.
   */
  priority?: UsenetPriority;
  /** Whether the content aired/released recently. Defaults to false (older). */
  isRecent?: boolean;
}

/** Normalized usenet queue priority; each client maps it to its own scale. */
export type UsenetPriority = 'veryLow' | 'low' | 'normal' | 'high' | 'veryHigh' | 'force';

export interface AddNzbResult {
  /** The id the item will have in `getItems()` (SABnzbd nzo_id, NZBGet NZBID). */
  id: string;
  warnings: string[];
}

export interface DownloadClientStatus {
  /** Directory the client saves into for our category, as the client sees it. */
  outputRootDir: string;
  /** True when the client runs on the same host as Arclight. */
  isLocalhost: boolean;
  /**
   * True when the client itself deletes torrents once seeding limits are hit, which
   * races with importing. The api should surface this as a health warning.
   */
  removesCompletedDownloads: boolean;
}

export interface DownloadClientTestResult {
  /** Human-readable client version, e.g. "5.0.2". */
  version: string;
  /** Client API version, e.g. "2.11.2". */
  apiVersion: string;
  /** Non-fatal configuration problems the user should know about. */
  warnings: string[];
}

export interface DownloadClient {
  readonly name: string;
  /**
   * The protocol the client downloads. Every client in this package sets it; it is optional
   * only so hand-written test doubles elsewhere keep compiling. Undefined means 'torrent'.
   */
  readonly protocol?: DownloadProtocol;
  /** Verifies connectivity, credentials, version and category. Throws `DownloadClientError`. */
  test(): Promise<DownloadClientTestResult>;
  /** Torrent clients only; usenet clients throw `DownloadClientError('not-supported')`. */
  addTorrent(input: AddTorrentInput): Promise<AddTorrentResult>;
  /** Usenet clients only; torrent clients throw `DownloadClientError('not-supported')`. */
  addNzb?(input: AddNzbInput): Promise<AddNzbResult>;
  getItems(category: string): Promise<DownloadItem[]>;
  removeItem(id: string, deleteData: boolean): Promise<void>;
  getStatus(): Promise<DownloadClientStatus>;
  /** Moves an item to another category (e.g. a post-import category). */
  setCategory(id: string, category: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  /**
   * Optional: ask the trackers (and the DHT, where the client does that) for fresh peers of a
   * torrent now, e.g. when it stalled. Clients without the concept (usenet) omit it.
   */
  reannounce?(id: string): Promise<void>;
  /**
   * Optional: set the port the client listens on for incoming peer connections (used to
   * follow a VPN's forwarded port). Clients without the concept omit it.
   */
  setListenPort?(port: number): Promise<void>;
  /** Optional: the client's current incoming-connections port. */
  getListenPort?(): Promise<number>;
}

export type DownloadClientErrorCode =
  /** Credentials rejected, session could not be established, or IP banned. */
  | 'auth'
  /** Network failure, DNS, refused connection, TLS or timeout. */
  | 'unreachable'
  /** The client answered with something we could not understand or an unexpected status. */
  | 'bad-response'
  /** The endpoint or the referenced item does not exist. */
  | 'not-found'
  /** The client refused the request itself (duplicate torrent, invalid torrent file, ...). */
  | 'rejected'
  /** The operation does not apply to this client (e.g. an NZB sent to a torrent client). */
  | 'not-supported';

export class DownloadClientError extends Error {
  override readonly name = 'DownloadClientError';
  readonly code: DownloadClientErrorCode;
  /** HTTP status of the response that caused the error, when there was one. */
  readonly httpStatus: number | undefined;

  constructor(
    code: DownloadClientErrorCode,
    message: string,
    options: { cause?: unknown; httpStatus?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.httpStatus = options.httpStatus;
  }
}

/** Injectable runtime dependencies, so clients are testable without a network. */
export interface ClientRuntime {
  fetch: typeof globalThis.fetch;
  /** Milliseconds since epoch. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
}
