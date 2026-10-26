import type {
  CustomFormatInput,
  DelayProfileInput,
  ImportListCreate,
  IndexerCreate,
  IndexerProxyCreate,
  MediaInfo,
  MediaImage,
  MediaManagementSettings,
  MigrateApp,
  MigrateArea,
  MigrateAreaMode,
  MigrateStagingArea,
  MigrationWarning,
  MinimumAvailability,
  MovieCollection,
  MovieStatus,
  NamingConfig,
  NotificationInputRaw,
  QualityModel,
  QualityProfileInput,
  Ratings,
  SeriesStatus,
  SeriesType,
} from '@arclight/shared';
import type { MigrationPlan } from '@arclight/shared';
import type { AreaEnv } from './areas.js';
import type { TorrentPayload } from './qbittorrent-reader.js';
import type { NativeDownloadClientInput, StagedDownloadClient } from './mappers/download-clients.js';
import type { SeerrIssuePayload, SeerrRequestPayload, SeerrSettingsPayload, SeerrUserPayload } from './types-requests.js';
import type { SubtitleAssignmentPayload, SubtitleEventPayload, SubtitleFilePayload, SubtitleProfilePayload, SubtitleProviderPayload } from './types-subtitles.js';

// The normalised, already-mapped view of a source installation that readers produce and the
// service plans/applies. Cross references (tags, profiles, formats, indexers, parents) stay
// as upstream ids (`source*`) and are resolved to Arclight ids at apply time.

export interface SourceItem<P> {
  /** Upstream primary key (as text). */
  sourceId: string;
  /** Human label for plans and logs. */
  name: string;
  payload: P;
  /** Set when the item cannot be imported; `stageArea` stages it instead of dropping it. */
  unsupported?: string;
  stageArea?: MigrateStagingArea;
}

export interface AreaBundle<P> {
  mode: MigrateAreaMode;
  items: SourceItem<P>[];
  details?: Record<string, number>;
}

export interface TagPayload {
  label: string;
}

export interface RootFolderPayload {
  path: string;
  mediaType: 'series' | 'movie';
}

export interface CustomFormatPayload {
  input: CustomFormatInput;
}

export interface QualityProfilePayload {
  input: Omit<QualityProfileInput, 'formatItems'>;
  formatItems: Array<{ sourceFormatId: string; score: number }>;
}

export interface DelayProfilePayload {
  input: Omit<DelayProfileInput, 'tags'>;
  sourceTagIds: number[];
}

export interface ReleaseProfilePayload {
  name: string;
  enabled: boolean;
  required: string[];
  ignored: string[];
  sourceIndexerId: number | null;
  sourceTagIds: number[];
}

export interface IndexerPayload {
  create: Omit<IndexerCreate, 'tags' | 'downloadClientId'>;
  sourceTagIds: number[];
  sourceDownloadClientId: number | null;
}

/** A Prowlarr indexer proxy (FlareSolverr, HTTP, SOCKS5). */
export interface IndexerProxyPayload {
  create: Omit<IndexerProxyCreate, 'tags'>;
  sourceTagIds: number[];
}

export interface DownloadClientPayload {
  input: NativeDownloadClientInput | null;
  staged: StagedDownloadClient | null;
  sourceTagIds: number[];
}

export interface RemotePathMappingPayload {
  host: string;
  remotePath: string;
  localPath: string;
}

export interface NotificationPayload {
  input: Omit<NotificationInputRaw, 'tags'>;
  sourceTagIds: number[];
}

export interface ImportListPayload {
  input: Omit<ImportListCreate, 'qualityProfileId' | 'tags'>;
  sourceQualityProfileId: number | null;
  sourceTagIds: number[];
}

export interface SettingsPayload<T> {
  values: Partial<T>;
}

export interface FilePayload {
  sourceId: string;
  seasonNumber: number | null;
  relativePath: string;
  path: string;
  sizeBytes: number;
  dateAdded: string | null;
  quality: QualityModel;
  languages: string[];
  releaseGroup: string | null;
  sceneName: string | null;
  edition: string | null;
  mediaInfo: MediaInfo | null;
}

export interface EpisodePayload {
  sourceId: string;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number | null;
  title: string | null;
  overview: string | null;
  airDate: string | null;
  airDateUtc: string | null;
  runtimeMinutes: number | null;
  monitored: boolean;
  sourceFileId: string | null;
}

export interface SeriesPayload {
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  title: string;
  year: number;
  overview: string;
  status: SeriesStatus;
  network: string | null;
  runtimeMinutes: number | null;
  genres: string[];
  images: MediaImage[];
  ratings: Ratings;
  certification: string | null;
  originalLanguage: string;
  path: string;
  rootFolderPath: string;
  sourceQualityProfileId: number | null;
  monitored: boolean;
  monitorNewItems: 'all' | 'none';
  seriesType: SeriesType;
  seasonFolder: boolean;
  useSceneNumbering: boolean;
  sourceTagIds: number[];
  added: string | null;
  seasons: Array<{ seasonNumber: number; monitored: boolean }>;
  episodes: EpisodePayload[];
  files: FilePayload[];
}

export interface MoviePayload {
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  originalTitle: string;
  year: number;
  overview: string;
  status: MovieStatus;
  inCinemas: string | null;
  digitalRelease: string | null;
  physicalRelease: string | null;
  runtimeMinutes: number | null;
  studio: string | null;
  genres: string[];
  images: MediaImage[];
  ratings: Ratings;
  certification: string | null;
  originalLanguage: string;
  collection: MovieCollection | null;
  path: string;
  rootFolderPath: string;
  sourceQualityProfileId: number | null;
  minimumAvailability: MinimumAvailability;
  monitored: boolean;
  sourceTagIds: number[];
  added: string | null;
  file: FilePayload | null;
}

export interface HistoryPayload {
  mediaType: 'series' | 'movie';
  sourceSeriesId: number | null;
  sourceEpisodeId: number | null;
  sourceMovieId: number | null;
  eventType: 'grabbed' | 'downloadFolderImported';
  sourceTitle: string;
  quality: QualityModel;
  languages: string[];
  date: string;
  downloadId: string | null;
  data: Record<string, string>;
}

export interface BlocklistPayload {
  mediaType: 'series' | 'movie';
  sourceSeriesId: number | null;
  sourceEpisodeIds: number[];
  sourceMovieId: number | null;
  sourceTitle: string;
  quality: QualityModel;
  languages: string[];
  date: string;
  publishedDate: string | null;
  size: number | null;
  protocol: 'usenet' | 'torrent';
  indexer: string | null;
  indexerFlags: string[];
  message: string | null;
  torrentInfoHash: string | null;
  releaseType: string | null;
}

export interface AreaPayloads {
  tags: TagPayload;
  rootFolders: RootFolderPayload;
  customFormats: CustomFormatPayload;
  qualityProfiles: QualityProfilePayload;
  delayProfiles: DelayProfilePayload;
  releaseProfiles: ReleaseProfilePayload;
  indexers: IndexerPayload;
  indexerProxies: IndexerProxyPayload;
  applications: unknown;
  downloadClients: DownloadClientPayload;
  remotePathMappings: RemotePathMappingPayload;
  notifications: NotificationPayload;
  importLists: ImportListPayload;
  naming: SettingsPayload<NamingConfig>;
  mediaManagement: SettingsPayload<MediaManagementSettings>;
  series: SeriesPayload;
  movies: MoviePayload;
  collections: unknown;
  history: HistoryPayload;
  blocklist: BlocklistPayload;
  subtitleProfiles: SubtitleProfilePayload;
  subtitleProviders: SubtitleProviderPayload;
  subtitleHistory: SubtitleEventPayload;
  users: SeerrUserPayload;
  requests: SeerrRequestPayload;
  issues: SeerrIssuePayload;
  requestSettings: SeerrSettingsPayload;
  subtitleFiles: SubtitleFilePayload;
  subtitleAssignments: SubtitleAssignmentPayload;
  torrents: TorrentPayload;
}

export type SourceAreas = { [A in MigrateArea]?: AreaBundle<AreaPayloads[A]> };

export interface SourceBundle {
  app: MigrateApp;
  schemaVersion: string | null;
  warnings: MigrationWarning[];
  areas: SourceAreas;
  /** Extra plan fields computed against the current database (qBittorrent categories). */
  planExtras?: (env: AreaEnv) => Pick<MigrationPlan, 'torrentCategories'>;
}

/** A staged area: every item carries its `stageArea`. */
export function stagedArea<P>(items: SourceItem<P>[], details?: Record<string, number>): AreaBundle<P> {
  return details ? { mode: 'stage', items, details } : { mode: 'stage', items };
}
