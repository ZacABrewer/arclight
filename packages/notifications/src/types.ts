/**
 * The common notification event model.
 *
 * The api raises one `NotificationEvent` whenever something a user might want to hear about
 * happens (a grab, an import, a health change, ...). Every agent in this package consumes the
 * same event shape, so the api never formats messages or knows which service it is talking to.
 *
 * Payloads are deliberately rich: webhook and custom-script agents forward them verbatim, and
 * the chat agents pick the fields they render.
 */

import type { DailySummary, HealthCheck } from '@arclight/shared';

export type { DailySummary, HealthCheck };

/** What an event is about. Music events carry `artist`/`album`/`tracks`, audiobook events `author`/`book`. */
export type MediaType = 'series' | 'movie' | 'music' | 'audiobook';

/** The video subset (requests, issues, retention and media-server lookups are video only). */
export type VideoMediaType = 'series' | 'movie';

export const isVideoMediaType = (t: MediaType): t is VideoMediaType => t === 'series' || t === 'movie';

export interface MediaImage {
  coverType: 'poster' | 'fanart' | 'banner' | 'clearlogo';
  /** Absolute URL a third party can load (remote CDN or Arclight's image cache). */
  url: string;
}

/**
 * The series, movie, artist or author an event is about. Music: `title` is the artist name,
 * `path` the artist folder, `tmdbId` 0. Audiobooks: `title` is the author name, `path` the
 * author folder.
 */
export interface MediaInfo {
  id: number;
  mediaType: MediaType;
  title: string;
  year: number;
  /** 0 for music and audiobooks. */
  tmdbId: number;
  imdbId?: string;
  tvdbId?: number;
  /** Absolute path of the series/movie folder on disk. */
  path: string;
  overview?: string;
  genres: string[];
  tags: string[];
  /** 0..10 */
  rating?: number;
  images: MediaImage[];
}

/** Music: the artist (MediaInfo carries the same name as `title`). */
export interface ArtistInfo {
  id: number;
  name: string;
  /** MusicBrainz artist id. */
  mbArtistId?: string;
  disambiguation?: string;
  /** Absolute artist folder. */
  path?: string;
}

/** Music: the album an event is about. */
export interface AlbumInfo {
  id: number;
  title: string;
  /** `Album`, `EP`, `Single`... */
  albumType?: string;
  /** ISO-8601 date (YYYY-MM-DD) of the release group's first release. */
  releaseDate?: string;
  /** MusicBrainz release-group id. */
  mbReleaseGroupId?: string;
  /** MusicBrainz release id of the selected edition. */
  mbReleaseId?: string;
  /** Absolute album folder. */
  path?: string;
}

/** Music: a track the event touched (imported, grabbed, deleted). */
export interface TrackInfo {
  id: number;
  title: string;
  mediumNumber: number;
  trackNumber: number;
  durationMs?: number;
  /** MusicBrainz recording id. */
  mbRecordingId?: string;
}

/** Audiobooks: the author (MediaInfo carries the same name as `title`). */
export interface AuthorInfo {
  id: number;
  name: string;
  asin?: string;
  path?: string;
}

/** Audiobooks: the book an event is about. */
export interface BookInfo {
  id: number;
  title: string;
  subtitle?: string;
  narrators: string[];
  seriesTitle?: string;
  seriesPosition?: string;
  asin?: string;
  isbn?: string;
  /** ISO-8601 date. */
  releaseDate?: string;
  runtimeMs?: number;
  path?: string;
}

export interface EpisodeInfo {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber?: number;
  title: string;
  overview?: string;
  /** ISO-8601 date (YYYY-MM-DD). */
  airDate?: string;
}

/** A release that was (or is being) grabbed. */
export interface ReleaseInfo {
  title: string;
  /** Quality name from `@arclight/shared` `QUALITIES`, e.g. "WEBDL-1080p". */
  quality: string;
  /** 1 for the original release, 2+ for PROPER/REPACK revisions. */
  qualityVersion: number;
  indexer?: string;
  /** Bytes. */
  size: number;
  releaseGroup?: string;
  customFormats: string[];
  customFormatScore: number;
  indexerFlags?: string[];
}

export interface DownloadClientInfo {
  downloadClient?: string;
  downloadClientType?: string;
  downloadId?: string;
}

export interface MediaStreamInfo {
  videoCodec?: string;
  videoDynamicRange?: string;
  width?: number;
  height?: number;
  audioCodec?: string;
  audioChannels?: number;
  audioLanguages: string[];
  subtitleLanguages: string[];
}

/** A file in the library (episode file or movie file). */
export interface MediaFileInfo {
  id: number;
  path: string;
  /** Relative to the series/movie folder. */
  relativePath: string;
  quality: string;
  qualityVersion: number;
  releaseGroup?: string;
  sceneName?: string;
  /** Bytes. */
  size: number;
  /** ISO-8601 timestamp. */
  dateAdded: string;
  languages: string[];
  mediaInfo?: MediaStreamInfo;
  /** Where the file came from (import only). */
  sourcePath?: string;
  /** Where a replaced/deleted file was moved to, when the recycle bin is enabled. */
  recycleBinPath?: string;
}

export interface RenamedFileInfo {
  fileId: number;
  previousPath: string;
  previousRelativePath: string;
  path: string;
  relativePath: string;
}

export interface DownloadStatusMessage {
  title: string;
  messages: string[];
}

export interface RequestInfo {
  id: number;
  requestedBy: { id: number; username: string; avatar?: string; email?: string };
  status: 'pending' | 'approved' | 'declined' | 'available';
  /** Requested seasons, series only. Empty means the whole series. */
  seasons?: number[];
  is4k?: boolean;
}

export interface IssueInfo {
  id: number;
  issueType: 'video' | 'audio' | 'subtitles' | 'other';
  status: 'open' | 'resolved';
  reportedBy: { id: number; username: string };
  /** The first comment (the report itself). */
  message: string;
  problemSeason?: number;
  problemEpisode?: number;
  /** For comment events: the new comment. */
  comment?: { user: { id: number; username: string }; message: string };
  /** What changed: a new comment, or a status change. */
  change?: 'comment' | 'resolved' | 'reopened';
}

export interface SubtitleInfo {
  language: string;
  provider: string;
  path: string;
  score?: number;
  forced?: boolean;
  hearingImpaired?: boolean;
}

export const NOTIFICATION_EVENT_TYPES = [
  'test',
  'grab',
  'import',
  'upgrade',
  'rename',
  'mediaAdded',
  'mediaDeleted',
  'fileDeleted',
  'healthIssue',
  'healthRestored',
  'applicationUpdate',
  'manualInteractionRequired',
  'subtitleDownloaded',
  'requestCreated',
  'requestApproved',
  'requestAvailable',
  'requestDeclined',
  'issueCreated',
  'issueUpdated',
  'requestsDigest',
  'retention',
  'fileTranscoded',
  'downloadStalled',
  'killSwitch',
  'killSwitchResumed',
  'importProblem',
  'diskSpaceLow',
  'downloadUpdate',
  'dailySummary',
  'heldAlerts',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

interface EventBase {
  /** Configured instance name, shown as the sender in chat agents. */
  instanceName: string;
  /** Public URL of this Arclight, used for links. */
  applicationUrl?: string;
  /** ISO-8601 timestamp of when the event happened. */
  timestamp: string;
  /** Delivered even during quiet hours (disk full, a long kill-switch lockdown). */
  urgent?: boolean;
}

interface MediaEventBase extends EventBase {
  media: MediaInfo;
  /** Present for series events; absent (or empty) for movies. */
  episodes?: EpisodeInfo[];
  /** Music events. */
  artist?: ArtistInfo;
  album?: AlbumInfo;
  tracks?: TrackInfo[];
  /** Audiobook events. */
  author?: AuthorInfo;
  book?: BookInfo;
}

export interface TestEvent extends EventBase {
  type: 'test';
  message?: string;
}

export interface GrabEvent extends MediaEventBase, DownloadClientInfo {
  type: 'grab';
  release: ReleaseInfo;
}

export interface ImportEvent extends MediaEventBase, DownloadClientInfo {
  type: 'import';
  file: MediaFileInfo;
  release?: ReleaseInfo;
}

export interface UpgradeEvent extends MediaEventBase, DownloadClientInfo {
  type: 'upgrade';
  file: MediaFileInfo;
  release?: ReleaseInfo;
  /** The files this import replaced. */
  oldFiles: MediaFileInfo[];
}

export interface RenameEvent extends MediaEventBase {
  type: 'rename';
  renamedFiles: RenamedFileInfo[];
}

export interface MediaAddedEvent extends MediaEventBase {
  type: 'mediaAdded';
  addMethod: 'manual' | 'list' | 'request';
}

export interface MediaDeletedEvent extends MediaEventBase {
  type: 'mediaDeleted';
  /** Whether the folder on disk was deleted as well. */
  deletedFiles: boolean;
}

export interface FileDeletedEvent extends MediaEventBase {
  type: 'fileDeleted';
  file: MediaFileInfo;
  reason: 'manual' | 'missingFromDisk' | 'upgrade' | 'noLinkedMedia';
}

export interface HealthIssueEvent extends EventBase {
  type: 'healthIssue';
  health: HealthCheck;
}

export interface HealthRestoredEvent extends EventBase {
  type: 'healthRestored';
  /** The check as it was while failing. */
  health: HealthCheck;
}

export interface ApplicationUpdateEvent extends EventBase {
  type: 'applicationUpdate';
  previousVersion: string;
  newVersion: string;
  message?: string;
}

export interface ManualInteractionRequiredEvent extends EventBase, DownloadClientInfo {
  type: 'manualInteractionRequired';
  media?: MediaInfo;
  episodes?: EpisodeInfo[];
  release?: ReleaseInfo;
  downloadTitle: string;
  downloadStatus: string;
  statusMessages: DownloadStatusMessage[];
}

export interface SubtitleDownloadedEvent extends MediaEventBase {
  type: 'subtitleDownloaded';
  subtitle: SubtitleInfo;
}

export interface RequestCreatedEvent extends MediaEventBase {
  type: 'requestCreated';
  request: RequestInfo;
}

export interface RequestApprovedEvent extends MediaEventBase {
  type: 'requestApproved';
  request: RequestInfo;
}

export interface RequestAvailableEvent extends MediaEventBase {
  type: 'requestAvailable';
  request: RequestInfo;
}

export interface RequestDeclinedEvent extends MediaEventBase {
  type: 'requestDeclined';
  request: RequestInfo;
  reason?: string;
}

export interface IssueCreatedEvent extends MediaEventBase {
  type: 'issueCreated';
  issue: IssueInfo;
}

export interface IssueUpdatedEvent extends MediaEventBase {
  type: 'issueUpdated';
  issue: IssueInfo;
}

/** One line of the admin digest. */
export interface DigestRequestLine {
  id: number;
  mediaType: MediaType;
  title: string;
  year?: number;
  requestedBy: string;
  is4k: boolean;
  /** ISO-8601. */
  createdAt: string;
}

export interface DigestIssueLine {
  id: number;
  mediaType: MediaType;
  title: string;
  issueType: IssueInfo['issueType'];
  reportedBy: string;
  createdAt: string;
}

/** Daily summary for admins: what waits for approval and which issues are open. */
export interface RequestsDigestEvent extends EventBase {
  type: 'requestsDigest';
  /** Oldest first, at most a screenful; totals count everything. */
  pendingRequests: DigestRequestLine[];
  openIssues: DigestIssueLine[];
  totalPendingRequests: number;
  totalOpenIssues: number;
}

/** One item in a retention summary. */
export interface RetentionLine {
  mediaType: MediaType;
  title: string;
  year?: number;
  /** Rule that matched. */
  rule: string;
  action: 'unmonitor' | 'deleteFiles' | 'deleteItem';
  /** Bytes on disk. */
  sizeBytes: number;
  reasons: string[];
  /** Staged lines: when the item will be applied (ISO-8601). */
  applyAfter?: string;
  /** Failed lines: what went wrong. */
  error?: string;
}

/** Summary of a retention sweep for admins: newly staged, applied and failed items. */
export interface RetentionEvent extends EventBase {
  type: 'retention';
  /** At most a screenful per list; totals count everything. */
  staged: RetentionLine[];
  applied: RetentionLine[];
  failed: RetentionLine[];
  totalStaged: number;
  totalApplied: number;
  totalFailed: number;
  /** Bytes freed by the applied deletions. */
  freedBytes: number;
}

/** A library file was remuxed/transcoded in place by a transcode rule. */
export interface FileTranscodedEvent extends MediaEventBase {
  type: 'fileTranscoded';
  /** The file as it is now (path may have a new extension). */
  file: MediaFileInfo;
  previousPath: string;
  action: 'remux' | 'transcode' | 'stripTracks' | 'addAudioTrack';
  /** Rule name; absent when the rule was deleted. */
  rule?: string;
  /** Bytes. */
  sizeBefore: number;
  sizeAfter: number;
}

/** The tracked download an alert is about. */
export interface DownloadAlertInfo {
  /** Arclight's tracked-download id (GET /queue/:id/timeline). */
  trackedDownloadId: number;
  /** Client-side id (info-hash for torrents). */
  downloadId: string;
  title: string;
}

/** A download stopped receiving data for longer than the stall threshold. */
export interface DownloadStalledEvent extends EventBase {
  type: 'downloadStalled';
  download: DownloadAlertInfo;
  message?: string;
}

/**
 * The VPN kill switch paused the built-in engine's downloads. One event per lockdown, not per
 * torrent. `pausedMinutes` is set on the reminder sent when a lockdown outlasts the urgent limit.
 */
export interface KillSwitchEvent extends EventBase {
  type: 'killSwitch';
  reason?: string;
  /** ISO-8601 start of the lockdown. */
  since: string;
  /** Downloads paused by this lockdown (titles at most a screenful). */
  pausedCount: number;
  titles: string[];
  pausedMinutes?: number;
}

/** The lockdown ended and the kill switch resumed what it paused. */
export interface KillSwitchResumedEvent extends EventBase {
  type: 'killSwitchResumed';
  reason?: string;
  resumedCount: number;
  /** How long the lockdown lasted. */
  durationMs: number;
}

/** A finished download could not be imported (failed), or waits for a person (blocked). */
export interface ImportProblemEvent extends EventBase {
  type: 'importProblem';
  problem: 'failed' | 'blocked';
  download: DownloadAlertInfo;
  message?: string;
}

/** A disk-space health check went into warning or error. */
export interface DiskSpaceLowEvent extends EventBase {
  type: 'diskSpaceLow';
  health: HealthCheck;
}

/**
 * Any other download timeline entry (recovered, a replaced release, a held grab, ...): the
 * message comes from the timeline entry, so new entry types need no formatting of their own.
 */
export interface DownloadUpdateEvent extends EventBase {
  type: 'downloadUpdate';
  download: DownloadAlertInfo;
  /** Timeline entry type, e.g. "recovered". */
  timelineType: string;
  severity: 'info' | 'ok' | 'warning' | 'error';
  message?: string;
}

/** The daily summary (stored; GET /summary/latest). */
export interface DailySummaryEvent extends EventBase {
  type: 'dailySummary';
  summary: DailySummary;
}

/** Alerts held during quiet hours, delivered as one message when they end. */
export interface HeldAlertsEvent extends EventBase {
  type: 'heldAlerts';
  /** Oldest first. */
  events: NotificationEvent[];
  /** ISO-8601 of the first held alert. */
  heldSince: string;
}

export type NotificationEvent =
  | TestEvent
  | DownloadStalledEvent
  | KillSwitchEvent
  | KillSwitchResumedEvent
  | ImportProblemEvent
  | DiskSpaceLowEvent
  | DownloadUpdateEvent
  | DailySummaryEvent
  | HeldAlertsEvent
  | GrabEvent
  | ImportEvent
  | UpgradeEvent
  | RenameEvent
  | MediaAddedEvent
  | MediaDeletedEvent
  | FileDeletedEvent
  | HealthIssueEvent
  | HealthRestoredEvent
  | ApplicationUpdateEvent
  | ManualInteractionRequiredEvent
  | SubtitleDownloadedEvent
  | RequestCreatedEvent
  | RequestApprovedEvent
  | RequestAvailableEvent
  | RequestDeclinedEvent
  | IssueCreatedEvent
  | IssueUpdatedEvent
  | RequestsDigestEvent
  | RetentionEvent
  | FileTranscodedEvent;

export type NotificationEventOf<T extends NotificationEventType> = Extract<
  NotificationEvent,
  { type: T }
>;

export const NOTIFICATION_AGENT_KINDS = [
  'discord',
  'telegram',
  'webhook',
  'email',
  'custom-script',
  'ntfy',
  'gotify',
  'pushover',
  'jellyfin',
  'emby',
  'plex',
] as const;
export type NotificationAgentKind = (typeof NOTIFICATION_AGENT_KINDS)[number];

export interface NotificationAgent {
  readonly kind: NotificationAgentKind;
  /** Events this agent can do something useful with. The api should not call `send` with others. */
  readonly supportedEvents: ReadonlySet<NotificationEventType>;
  /** Deliver one event. Throws `NotificationError`; never resolves with a partial failure. */
  send(event: NotificationEvent): Promise<void>;
  /** Verify settings against the real service (sends a test message or pings it). */
  test(): Promise<void>;
}

export type NotificationErrorCode =
  /** Settings failed validation or are internally inconsistent. */
  | 'invalidSettings'
  /** Could not reach the service at all (DNS, refused, reset). */
  | 'network'
  /** The service did not answer in time. */
  | 'timeout'
  /** 401/403 or an auth handshake failure. */
  | 'unauthorized'
  /** 404 or a lookup (Plex section, library item) found nothing. */
  | 'notFound'
  /** 429. */
  | 'rateLimited'
  /** Any other non-2xx or malformed response. */
  | 'remoteError'
  /** The agent was asked to send an event type it does not support. */
  | 'unsupportedEvent'
  /** A custom script exited non-zero or could not be started. */
  | 'scriptFailed'
  /** SMTP conversation failed (unexpected reply code). */
  | 'smtp';

export class NotificationError extends Error {
  readonly code: NotificationErrorCode;
  readonly agent: NotificationAgentKind;
  /** HTTP status when the error came from an HTTP response. */
  readonly status: number | undefined;

  constructor(
    agent: NotificationAgentKind,
    code: NotificationErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NotificationError';
    this.agent = agent;
    this.code = code;
    this.status = options.status;
  }
}
