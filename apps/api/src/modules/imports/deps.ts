import type { MediaFile, MediaType, ProfileMismatchAction } from '@arclight/shared';
import type { TrackedDownload } from '../download-clients/index.js';

// Hooks into modules that are written in parallel (history, notifications, blocklist,
// releases). The imports module calls them when present and works without them; app.ts
// wires real implementations through `importsModuleWith(deps)` or `service.setDeps(...)`.

/** One imported file, as reported to history and notifications. */
export interface ImportedEvent {
  mediaType: MediaType;
  seriesId?: number;
  movieId?: number;
  episodeIds: number[];
  file: MediaFile;
  /** Files that were replaced (already recycled/deleted). */
  replacedFiles: MediaFile[];
  sourcePath: string;
  /** Null for manual imports of untracked folders. */
  downloadId: string | null;
  /** Release title of the tracked download (or the file's scene name). */
  sourceTitle: string;
  isUpgrade: boolean;
  importMode: 'move' | 'copy' | 'hardlink';
  manual: boolean;
}

export interface ImportFailedEvent {
  downloadId: string | null;
  sourceTitle: string;
  mediaType?: MediaType;
  seriesId?: number;
  movieId?: number;
  episodeIds?: number[];
  message: string;
}

export interface HistoryHook {
  recordImport(event: ImportedEvent): void | Promise<void>;
  recordImportFailed?(event: ImportFailedEvent): void | Promise<void>;
  recordDownloadFailed?(item: TrackedDownload, message: string): void | Promise<void>;
}

export interface NotificationsHook {
  onImported(event: ImportedEvent): void | Promise<void>;
  onManualInteractionRequired?(item: TrackedDownload, messages: string[]): void | Promise<void>;
  onDownloadFailed?(item: TrackedDownload, message: string): void | Promise<void>;
}

export interface BlocklistAddInput {
  item: TrackedDownload;
  message: string;
  /** Opaque release snapshot stored at grab time. */
  grabbedRelease: unknown;
}

export interface BlocklistHook {
  add(input: BlocklistAddInput): void | Promise<void>;
}

export interface ResearchRequest {
  mediaType: MediaType;
  seriesId?: number;
  episodeIds?: number[];
  movieId?: number;
  reason: 'failedDownload';
}

export interface ReleasesHook {
  researchFor(request: ResearchRequest): void | Promise<void>;
}

/** Media info read from a file (ffprobe or similar). Null when the file could not be read. */
export interface ProbeResult {
  runtimeSeconds: number | null;
  audioStreams?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
}

export type Probe = (path: string) => Promise<ProbeResult | null>;

/** Free bytes on the volume holding `path`; null when unknown. */
export type FreeSpace = (path: string) => Promise<number | null>;

export interface ImportsDeps {
  history?: HistoryHook;
  notifications?: NotificationsHook;
  blocklist?: BlocklistHook;
  releases?: ReleasesHook;
  /**
   * Media probe. When absent, runtime-based sample detection is skipped (name rule only);
   * when present and it returns null, the file is SampleIndeterminate (spec 8.2).
   */
  probe?: Probe;
  freeSpace?: FreeSpace;
  /** Profile-migration rule per quality profile (see DecisionContext.mismatchAction). Omitted = `none`. */
  profileMigration?: { mismatchActionFor(qualityProfileId: number): ProfileMismatchAction };
}
