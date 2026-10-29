import type { AnyMediaType, ProfileMismatchAction, QualityModel, ReleaseProtocol, ReleaseResource } from '@arclight/shared';

// Hooks the releases module needs from modules written in parallel (history, blocklist,
// settings). Each has a no-op default so the module works stand-alone; the app wires the
// real implementations through `releasesModuleWith(deps)`.

export type DownloadPropersAndRepacks = 'preferAndUpgrade' | 'doNotUpgrade' | 'doNotPrefer';

/** Library item a history/blocklist question is scoped to. */
export type ItemRef =
  | { episodeId: number; seriesId: number }
  | { movieId: number }
  | { albumId: number; artistId: number }
  | { bookId: number; authorId: number };

export interface HistoryEventSummary {
  eventType: 'grabbed' | 'downloadFolderImported' | 'downloadFailed' | (string & {});
  /** ISO-8601. */
  date: string;
  sourceTitle: string;
  quality: QualityModel;
  downloadId?: string;
  sizeBytes?: number;
}

export interface GrabHistoryInput {
  mediaType: AnyMediaType;
  seriesId?: number;
  episodeIds?: number[];
  movieId?: number;
  artistId?: number;
  albumIds?: number[];
  authorId?: number;
  bookIds?: number[];
  sourceTitle: string;
  quality: QualityModel;
  languages: string[];
  customFormatScore: number;
  releaseGroup?: string;
  indexerId: number;
  indexerName: string;
  protocol: ReleaseProtocol;
  guid: string;
  size: number;
  publishDate: string;
  infoUrl?: string;
  downloadClientId: number | null;
  downloadClientName: string | null;
  /** Client-side id (info-hash for torrents). */
  downloadId: string;
  source: string;
  /** Decision-log batch the grab was chosen from (GET /release/decisions/:batchId). */
  batchId?: string;
  /** "Grab anyway": the permanent rejections the user overrode (absent for approved grabs). */
  overriddenRejections?: string[];
}

export interface HistoryWriter {
  recordGrab(grab: GrabHistoryInput): void | Promise<void>;
  /**
   * Most recent history event for the item (optionally of one type). Optional: without it
   * the history specs (recent grab / already imported) accept everything.
   */
  latestFor?(item: ItemRef, eventType?: string): HistoryEventSummary | null | Promise<HistoryEventSummary | null>;
  /** The event of this type recorded for a download id, if any (already-imported spec). */
  findByDownloadId?(downloadId: string, eventType: string): HistoryEventSummary | null | Promise<HistoryEventSummary | null>;
}

export interface BlocklistCandidate {
  mediaType: AnyMediaType;
  seriesId?: number;
  episodeIds?: number[];
  movieId?: number;
  artistId?: number;
  albumIds?: number[];
  authorId?: number;
  bookIds?: number[];
  title: string;
  protocol: ReleaseProtocol;
  indexerId: number;
  /** Lower-case hex, torrents only. */
  infoHash?: string;
  publishDate: string;
}

export interface BlocklistReader {
  isBlocklisted(release: BlocklistCandidate): boolean | Promise<boolean>;
}

export interface PropersSetting {
  /** Settings section `mediaManagement`, field `downloadPropersAndRepacks`. */
  getDownloadPropersAndRepacks(): DownloadPropersAndRepacks;
}

/** Other engine knobs (decision-engine spec §2). All optional; defaults in DEFAULT_RELEASE_SETTINGS. */
export interface ReleaseSettings {
  /** Global hard cap in MB; 0 = off. */
  maximumSizeMb: number;
  /** Usenet: ignore releases newer than this (minutes); 0 = off. */
  minimumAgeMinutes: number;
  /** Usenet: ignore releases older than this (days); 0 = off. */
  retentionDays: number;
  /** Accept multi-season packs (§4.19). */
  allowMultiSeason: boolean;
  seasonPackUpgrade: 'all' | 'any' | 'percent';
  seasonPackUpgradeThreshold: number;
  /** Movies: extra days after the minimum-availability date. */
  availabilityDelayDays: number;
  /** Accept single-episode releases before the episode has aired. */
  allowUnairedEpisodes: boolean;
  /** Tolerance before the air time a single-episode release is accepted (minutes). */
  unairedToleranceMinutes: number;
  /** Settings → Indexers: accept releases with burned-in subtitles. */
  allowHardcodedSubs: boolean;
  /** Settings → Indexers: subtitle tags (`ENG`, `HC.ENG`, `KORSUB`) accepted even when hardcoded subs are not. */
  whitelistedHardcodedSubs: string[];
  /** Settings → Indexers: rank freeleech / double-upload releases above otherwise equal ones. */
  preferIndexerFlags: boolean;
  /** Music: automatic grabs of discography / multi-album packs (interactive grabs always may). */
  allowDiscographyPacks: boolean;
  /** Music: a pack must fill or upgrade at least this many wanted albums to be grabbed automatically. Audiobooks: the same for books. */
  minPackWanted: number;
  /** Audiobooks: automatic grabs of series packs ("Books 1-5", "Complete Series"; interactive grabs always may). */
  allowBookPacks: boolean;
  /** Audiobooks: accept abridged releases of books the catalogue lists as unabridged. */
  allowAbridged: boolean;
}

export interface ReleaseSettingsReader {
  getReleaseSettings(): Partial<ReleaseSettings>;
}

/** Free bytes at a path; null when unknown (accepted). */
export type FreeSpaceReader = (path: string) => number | null | Promise<number | null>;

export interface ReleasesDeps {
  history?: HistoryWriter;
  blocklist?: BlocklistReader;
  propers?: PropersSetting;
  settings?: ReleaseSettingsReader;
  /** Optional free-space probe for the tier-1 free space spec; omitted = check skipped. */
  freeSpace?: FreeSpaceReader;
  /** Minimum MB that must remain free after the download (free space spec). Default 100. */
  minimumFreeSpaceMb?: number;
  /**
   * Optional pre-grab check (the vpn module's `isSafeToGrab`). When it answers false the grab
   * is temporarily rejected with reason `vpnDown`; automatic grabs are parked as pending and
   * retried. Omitted = always allowed.
   */
  grabGuard?: GrabGuard;
  /**
   * Optional per-indexer release filter (the tracker-stats module's freeleech-only mode). A
   * non-null answer rejects the release (tier 0, permanent). Omitted = everything passes.
   */
  releaseFilter?: ReleaseFilter;
  /**
   * Optional profile-migration rule per quality profile ("when files don't meet this profile").
   * Omitted = `none` everywhere (classic upgrade rules).
   */
  profileMigration?: ProfileMigrationRules;
}

export interface ProfileMigrationRules {
  mismatchActionFor(qualityProfileId: number): ProfileMismatchAction;
}

/** Rejection (`reason` e.g. `notFreeleech`) or null when the release may be grabbed. */
export type ReleaseFilter = (
  indexerId: number,
  release: Pick<ReleaseResource, 'downloadVolumeFactor' | 'uploadVolumeFactor' | 'indexerFlags'>,
) => { reason: string; message: string } | null;

export interface GrabGuard {
  isSafeToGrab(): Promise<boolean>;
  /** Human-readable rejection message. */
  reason: string;
}

export const DEFAULT_RELEASE_SETTINGS: ReleaseSettings = {
  maximumSizeMb: 0,
  minimumAgeMinutes: 0,
  retentionDays: 0,
  allowMultiSeason: false,
  seasonPackUpgrade: 'all',
  seasonPackUpgradeThreshold: 100,
  availabilityDelayDays: 0,
  allowUnairedEpisodes: false,
  unairedToleranceMinutes: 60,
  allowHardcodedSubs: false,
  whitelistedHardcodedSubs: [],
  preferIndexerFlags: false,
  allowDiscographyPacks: false,
  minPackWanted: 2,
  allowBookPacks: false,
  allowAbridged: false,
};

export const noopHistory: HistoryWriter = { recordGrab: () => undefined };
export const noopBlocklist: BlocklistReader = { isBlocklisted: () => false };
export const defaultPropers: PropersSetting = { getDownloadPropersAndRepacks: () => 'preferAndUpgrade' };
