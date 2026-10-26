import type { FeedSummary, HealthCheck, HealthStatus, SubtitleWhisperStatus, TorrentSessionStatus, VpnStatus } from '@arclight/shared';

// Health check framework types. A check is a named function over `HealthDeps` (everything it
// may look at, injectable so tests use fakes) returning zero or more findings. A passing check
// returns []. Findings carry a docs URL built from a stable anchor.

export type PathPlatform = 'posix' | 'win32';

/** Docs page the `wikiUrl` anchors point into (served by the web app). */
export const HEALTH_DOCS_BASE = '/docs/system/health';

export const GIB = 1024 ** 3;

export interface HealthFs {
  /** True when `path` exists and is a directory. */
  isDirectory(path: string): Promise<boolean>;
  /** Probe by actually creating and removing a file. */
  canWrite(path: string): Promise<boolean>;
  /** True when the directory has no entries. */
  isEmpty(path: string): Promise<boolean>;
  /** Bytes available to this user, or null when unknown. */
  freeSpace(path: string): Promise<number | null>;
  /** The mount containing `path`, when the platform can tell. */
  mountOf(path: string): Promise<{ mountPoint: string; readOnly: boolean } | null>;
  /** Owner of `path`, when the platform can tell. */
  owner(path: string): Promise<{ uid: number; gid: number } | null>;
  /** Probe whether a file in `fromDir` can be hard-linked into `toDir`; null when it cannot be tested. */
  canHardLink?(fromDir: string, toDir: string): Promise<boolean | null>;
}

export interface HealthRootFolder {
  path: string;
  mediaType: 'series' | 'movie';
  /** Series/movies stored under this root. */
  itemCount: number;
}

export interface HealthDownloadClient {
  id: number;
  name: string;
  host: string;
}

export interface HealthClientStatus {
  outputRootDir: string;
  isLocalhost: boolean;
  removesCompletedDownloads: boolean;
}

export interface HealthIndexer {
  id: number;
  name: string;
  enableRss: boolean;
  enableAutomaticSearch: boolean;
  enableInteractiveSearch: boolean;
  /** ISO-8601; the indexer is in back-off until then. */
  disabledTill?: string;
  /** ISO-8601 of the first failure of the current failure streak. */
  initialFailure?: string;
}

export interface HealthNotification {
  id: number;
  name: string;
  /** Consecutive delivery failures since the last success. */
  consecutiveFailures: number;
}

export interface HealthDeps {
  appName: string;
  isDocker: boolean;
  configDir: string;
  platform: PathPlatform;
  now(): Date;
  processIds: { uid?: number; gid?: number };
  fs: HealthFs;
  rootFolders(): Promise<HealthRootFolder[]>;
  downloadClients: {
    /** Enabled clients in repository order. */
    enabled(): HealthDownloadClient[];
    /** Outcome of the queue poller's last request to the client, if any. */
    lastPoll(id: number): { ok: boolean; message?: string } | undefined;
    /** Live connection test. */
    test(id: number): Promise<{ ok: boolean; message?: string }>;
    status(id: number): Promise<HealthClientStatus>;
    /** Apply remote path mappings to a path the client reported. */
    toLocal(host: string, path: string): string;
  };
  indexers(): HealthIndexer[];
  tmdbKeyConfigured(): boolean;
  /** Configured recycle bin folder, or null when not configured. */
  recycleBin(): string | null;
  /** Tracked downloads that finished and wait for import. */
  pendingImports(): Array<{ id: number; title: string }>;
  notifications: {
    enabled(): HealthNotification[];
    misconfigured(): Array<{ id: number; name: string; error: string }>;
  };
  /** VPN status (vpn module); optional so deps built without it skip the VPN check. */
  vpn?(): Promise<VpnStatus>;
  /** Built-in torrent engine status (torrent module); optional so deps without it skip the check. */
  torrent?(): Promise<TorrentSessionStatus>;
  /** Liveness of every FlareSolverr-type indexer proxy (indexers module); optional so deps without it skip the check. */
  flareSolverrs?(): Promise<HealthFlareSolverr[]>;
  /** Reachability of Remote Engine download clients; optional so deps without it skip the check. */
  remoteEngines?(): Promise<Array<{ id: number; name: string; url: string; ok: boolean; message?: string }>>;
  /** Community indexer catalogue (indexers module); optional so deps without it skip the check. */
  indexerCatalogue?(): Promise<HealthIndexerCatalogue>;
  /** Self-updating data feeds (feeds registry); optional so deps without it skip the check. */
  feeds?(): Promise<FeedSummary[]>;
  /** Downloads still transferring (download-clients module); optional so deps without it skip the checks. */
  activeDownloads?(): Promise<HealthActiveDownload[]>;
  /** Media management "use hard links instead of copy"; optional so deps without it skip the check. */
  useHardlinks?(): boolean;
  /** Free space to keep on volumes (Settings > Media Management), bytes. */
  minimumFreeSpaceBytes?(): number;
  /** What the disk-space guard holds (download-clients module); optional so deps without it skip the check. */
  diskGuard?(): Promise<HealthDiskGuard>;
  /** Whisper ASR provider status (subtitles module); optional so deps without it skip the check. */
  whisper?(): Promise<SubtitleWhisperStatus>;
}

export interface HealthActiveDownload {
  id: number;
  title: string;
  /** Local content path, when known. */
  path?: string;
  sizeLeft: number;
  /** ISO-8601, set while the download counts as stalled. */
  stalledSince?: string;
}

export interface HealthDiskGuard {
  /** Titles of downloads paused because their volume fell below the minimum free space. */
  pausedTitles: string[];
  /** Titles of grabs held back until there is room. */
  heldTitles: string[];
  /** Download folders below the minimum, with their free bytes. */
  volumes: Array<{ path: string; freeBytes: number }>;
  minimumFreeBytes: number;
}

export interface HealthFlareSolverr {
  id: number;
  name: string;
  ok: boolean;
  message?: string;
}

export interface HealthCheckDef {
  /** Stable id, also the `source` of every finding it returns. */
  id: string;
  run(deps: HealthDeps): Promise<HealthCheck[]>;
}

export function docsUrl(anchor: string): string {
  return `${HEALTH_DOCS_BASE}#${anchor.replace(/^#/, '')}`;
}

export function finding(source: string, status: Exclude<HealthStatus, 'ok'>, message: string, anchor: string): HealthCheck {
  return { source, status, message, wikiUrl: docsUrl(anchor) };
}

export function formatMiB(bytes: number): string {
  return `${Math.floor(bytes / 1024 ** 2)} MiB`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface HealthIndexerCatalogue {
  enabled: boolean;
  lastSuccessAt: string | null;
  /** Definition files on disk. */
  files: number;
  /** Files that load. */
  supported: number;
}
