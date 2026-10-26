/**
 * Client-agnostic contract between Media-Tron and an external download client.
 *
 * Every concrete client (qBittorrent today; Transmission, Deluge, SABnzbd, NZBGet later)
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
}

export interface AddTorrentResult {
  /** The id the item will have in `getItems()` (lowercase info-hash for torrents). */
  id: string;
  /** Follow-up steps (priority, force start, share limits) that could not be applied. */
  warnings: string[];
}

export interface DownloadClientStatus {
  /** Directory the client saves into for our category, as the client sees it. */
  outputRootDir: string;
  /** True when the client runs on the same host as Media-Tron. */
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
  /** Verifies connectivity, credentials, version and category. Throws `DownloadClientError`. */
  test(): Promise<DownloadClientTestResult>;
  addTorrent(input: AddTorrentInput): Promise<AddTorrentResult>;
  getItems(category: string): Promise<DownloadItem[]>;
  removeItem(id: string, deleteData: boolean): Promise<void>;
  getStatus(): Promise<DownloadClientStatus>;
  /** Moves an item to another category (e.g. a post-import category). */
  setCategory(id: string, category: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
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
  | 'rejected';

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
