import type { MbRelease } from '@arclight/metadata';
import type { AudioFile, MediaFile, MediaType, ProfileMismatchAction, QualityModel } from '@arclight/shared';
import type { TrackedDownload } from '../download-clients/index.js';
import type { TagReader } from './audio/tags.js';

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

/**
 * One album imported by the music importer (one event per album, not per track), as reported
 * to history, notifications and the media-server refresh.
 */
export interface AudioImportedEvent {
  mediaType: 'music';
  artistId: number;
  albumId: number;
  /** `[albumId]`, the shape history targets use. */
  albumIds: number[];
  /** Tracks that received a file in this import. */
  trackIds: number[];
  files: AudioFile[];
  /** Files that were replaced (already recycled/deleted). */
  replacedFiles: AudioFile[];
  /** Best quality among the imported files. */
  quality: QualityModel;
  /** The album folder in the library (what media servers rescan). */
  albumFolder: string;
  /** The source album folder in the download. */
  sourcePath: string;
  /** Null for manual imports of untracked folders. */
  downloadId: string | null;
  sourceTitle: string;
  isUpgrade: boolean;
  importMode: 'move' | 'copy' | 'hardlink';
  manual: boolean;
  /** Some tracks of the edition still have no file (the album stays wanted). */
  incomplete: boolean;
}

/**
 * One book imported by the audiobook importer (one event per book, however many parts), as
 * reported to history, notifications and the media-server refresh.
 */
export interface AudiobookImportedEvent {
  mediaType: 'audiobook';
  authorId: number;
  bookId: number;
  /** `[bookId]`, the shape history targets use. */
  bookIds: number[];
  /** The book's files in part order. */
  files: AudioFile[];
  /** Files that were replaced (already recycled/deleted). */
  replacedFiles: AudioFile[];
  /** Best quality among the imported files. */
  quality: QualityModel;
  /** The book folder in the library (what media servers rescan). */
  bookFolder: string;
  /** The source book folder (or file) in the download. */
  sourcePath: string;
  /** Null for manual imports of untracked folders. */
  downloadId: string | null;
  sourceTitle: string;
  isUpgrade: boolean;
  importMode: 'move' | 'copy' | 'hardlink';
  manual: boolean;
  /** Total duration of the imported files (null when a file's duration was unknown). */
  durationMs: number | null;
  /** Book-level notes (e.g. the tagged narrator differs from the catalogue). */
  warnings: string[];
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
  recordAudioImport?(event: AudioImportedEvent): void | Promise<void>;
  recordAudiobookImport?(event: AudiobookImportedEvent): void | Promise<void>;
  recordImportFailed?(event: ImportFailedEvent): void | Promise<void>;
  recordDownloadFailed?(item: TrackedDownload, message: string): void | Promise<void>;
}

export interface NotificationsHook {
  onImported(event: ImportedEvent): void | Promise<void>;
  onAudioImported?(event: AudioImportedEvent): void | Promise<void>;
  onAudiobookImported?(event: AudiobookImportedEvent): void | Promise<void>;
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

/** Post-import media-server refresh (music and audiobook imports; video refresh runs through notifications). */
export interface MediaServersHook {
  refreshPath(input: { path: string; mediaType: 'music' | 'audiobook'; updateType?: 'Created' | 'Modified' | 'Deleted' }): unknown;
}

/** Full MusicBrainz releases (with tracks), for switching an album's edition during import. */
export interface MusicReleasesHook {
  getRelease(mbReleaseId: string): Promise<MbRelease>;
}

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
  mediaServers?: MediaServersHook;
  /** Without it the music importer matches against the stored (selected) editions only. */
  musicReleases?: MusicReleasesHook;
  /** Audio tag reader; the combined music-metadata + ffprobe reader when absent. */
  tagReader?: TagReader;
  /**
   * Fetches a book's cover image for the `cover.jpg` sidecar (only with `audio.writeAbsSidecars`).
   * Global fetch when absent. The URL is the book's public catalogue image, never a tracker.
   */
  fetchImage?: (url: string) => Promise<Uint8Array | null>;
  /** Profile-migration rule per quality profile (see DecisionContext.mismatchAction). Omitted = `none`. */
  profileMigration?: { mismatchActionFor(qualityProfileId: number): ProfileMismatchAction };
}
