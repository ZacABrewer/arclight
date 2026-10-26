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

import type { HealthCheck } from '@arclight/shared';

export type { HealthCheck };

export type MediaType = 'series' | 'movie';

export interface MediaImage {
  coverType: 'poster' | 'fanart' | 'banner' | 'clearlogo';
  /** Absolute URL a third party can load (remote CDN or Arclight's image cache). */
  url: string;
}

/** The series or movie an event is about. */
export interface MediaInfo {
  id: number;
  mediaType: MediaType;
  title: string;
  year: number;
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
  requestedBy: { id: number; username: string };
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
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

interface EventBase {
  /** Configured instance name, shown as the sender in chat agents. */
  instanceName: string;
  /** Public URL of this Arclight, used for links. */
  applicationUrl?: string;
  /** ISO-8601 timestamp of when the event happened. */
  timestamp: string;
}

interface MediaEventBase extends EventBase {
  media: MediaInfo;
  /** Present for series events; absent (or empty) for movies. */
  episodes?: EpisodeInfo[];
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

export type NotificationEvent =
  | TestEvent
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
  | IssueUpdatedEvent;

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
