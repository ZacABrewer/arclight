import type { IssueStatus, IssueType, RequestStatus } from '@arclight/shared';

// Normalised Seerr (Overseerr / Jellyseerr) data, produced by the file reader (seerr-reader.ts)
// and the API reader (api/seerr-api.ts), applied by areas-requests.ts. Seerr user ids stay as
// source ids and are resolved through the `users` area. Paths are already remapped.

export interface SeerrUserPayload {
  email: string;
  username: string | null;
  displayName: string | null;
  /** Seerr permission bitfield (same bit values as Arclight's Permission). */
  permissions: number;
  userType: 'plex' | 'local' | 'jellyfin' | 'emby' | 'unknown';
  plexId: number | null;
  jellyfinUserId: string | null;
  /** Plex or Jellyfin/Emby account name, for the media-server link. */
  mediaServerUsername: string | null;
  avatar: string | null;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
  locale: string | null;
  createdAt: string | null;
}

export interface SeerrRequestPayload {
  mediaType: 'movie' | 'tv';
  tmdbId: number | null;
  tvdbId: number | null;
  status: RequestStatus | null;
  is4k: boolean;
  requestedBySourceId: string | null;
  modifiedBySourceId: string | null;
  seasons: Array<{ seasonNumber: number; status: RequestStatus | null }>;
  rootFolder: string | null;
  /** Sonarr/Radarr quality profile id of the server Seerr sent the request to. */
  profileId: number | null;
  /** Sonarr/Radarr tag ids. */
  tags: number[];
  isAutoRequest: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SeerrIssuePayload {
  issueType: IssueType;
  status: IssueStatus;
  mediaType: 'movie' | 'tv' | null;
  tmdbId: number | null;
  problemSeason: number;
  problemEpisode: number;
  createdBySourceId: string | null;
  modifiedBySourceId: string | null;
  comments: Array<{ userSourceId: string | null; message: string; createdAt: string | null }>;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SeerrMainSettings {
  kind: 'main';
  defaultPermissions: number | null;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
  partialRequestsEnabled: boolean | null;
  enableSpecialEpisodes: boolean | null;
  hideAvailable: boolean | null;
  applicationUrl: string | null;
}

export interface SeerrSlider {
  kind: 'slider';
  /** Seerr slider type number (1-based, same order as Arclight's DiscoverSliderType). */
  type: number;
  order: number;
  isBuiltIn: boolean;
  enabled: boolean;
  title: string | null;
  data: string | null;
}

export interface SeerrOverrideRule {
  kind: 'override';
  mediaType: 'movie' | 'tv';
  users: string[];
  genres: number[];
  languages: string[];
  keywords: number[];
  profileId: number | null;
  rootFolder: string | null;
  tags: number[];
}

export type SeerrSettingsPayload = SeerrMainSettings | SeerrSlider | SeerrOverrideRule;
