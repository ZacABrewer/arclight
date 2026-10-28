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
  recordImportFailed?(event: ImportFailedEvent): void | Promise<void>;
  recordDownloadFailed?(item: TrackedDownload, message: string): void | Promise<void>;
}

export interface NotificationsHook {
  onImported(event: ImportedEvent): void | Promise<void>;
  onAudioImported?(event: AudioImportedEvent): void | Promise<void>;
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

/** Post-import media-server refresh (audio imports; video refresh runs through notifications). */
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
  /** Profile-migration rule per quality profile (see DecisionContext.mismatchAction). Omitted = `none`. */
  profileMigration?: { mismatchActionFor(qualityProfileId: number): ProfileMismatchAction };
}
