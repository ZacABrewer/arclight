/**
 * The read model shared by every media-server client: libraries, users, items matched by
 * provider id, and per-user play state. Jellyfin, Emby and Plex are mapped onto these shapes
 * so callers (availability, retention, library refresh) never branch on the server kind.
 */

export const MEDIA_SERVER_KINDS = ['jellyfin', 'emby', 'plex'] as const;
export type MediaServerKind = (typeof MEDIA_SERVER_KINDS)[number];

/**
 * What a library (or item) holds. Series are matched and evaluated as a whole; music items are
 * albums; audiobook items are books.
 */
export type MediaKind = 'movie' | 'series' | 'music' | 'audiobook';

/** The video kinds (retention, TMDB-keyed availability). */
export type VideoMediaKind = Extract<MediaKind, 'movie' | 'series'>;
export const VIDEO_KINDS: readonly VideoMediaKind[] = ['movie', 'series'];

export interface ProviderIds {
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  /** MusicBrainz release-group id (music albums). Present only when the server reports one. */
  mbReleaseGroupId?: string | null;
  /** MusicBrainz artist id (album artist for albums). */
  mbArtistId?: string | null;
  /** Audible ASIN (audiobooks). */
  asin?: string | null;
  isbn?: string | null;
}

export interface ServerInfo {
  name: string;
  version?: string;
  /** Jellyfin/Emby server id or Plex machineIdentifier. */
  id?: string;
}

/** A Jellyfin/Emby virtual folder or a Plex library section. */
export interface MediaServerLibrary {
  /** Jellyfin/Emby ItemId of the folder, Plex section key. */
  id: string;
  name: string;
  /**
   * Jellyfin/Emby `movies`/`tvshows`/`music`/`books`; Plex `movie`/`show`/`artist`. Plex has no
   * audiobook type: audiobooks sit in `artist` (music) sections and the path decides. `other`
   * for photos, mixed folders and anything else.
   */
  type: MediaKind | 'other';
  /** Folders on disk as the server sees them. */
  locations: string[];
}

export interface MediaServerUser {
  /** Jellyfin/Emby user id, or the Plex server-local account id (1 = owner). */
  id: string;
  name: string;
  isAdmin: boolean;
  isDisabled: boolean;
  /** ISO-8601, when the server reports it. */
  lastActivityAt: string | null;
}

export interface MediaServerItem {
  /** Jellyfin/Emby item id or Plex ratingKey. */
  id: string;
  mediaType: MediaKind;
  title: string;
  year: number | null;
  ids: ProviderIds;
  /** Folder or file path as the server sees it, when exposed. */
  path: string | null;
  /** Library/section the item belongs to, when known. */
  libraryId: string | null;
}

/**
 * One user's play state for one item. For a series, `played` means every episode present on
 * the server is played; `playCount` sums episode plays; `positionMs` is the resume point of
 * the most advanced in-progress episode.
 */
export interface PlayState {
  userId: string;
  played: boolean;
  playCount: number;
  /** ISO-8601, null when never played. */
  lastPlayedAt: string | null;
  /** Resume position in milliseconds (0 when not in progress). */
  positionMs: number;
  /** Item runtime in milliseconds, when known. */
  durationMs: number | null;
  /** Series only: episodes present / played. */
  episodes?: { total: number; played: number };
}

export interface ItemPlayState {
  item: MediaServerItem;
  state: PlayState;
}

export interface FindItemsQuery {
  mediaType: MediaKind;
  tmdbId?: number | null;
  tvdbId?: number | null;
  imdbId?: string | null;
  mbReleaseGroupId?: string | null;
  mbArtistId?: string | null;
  asin?: string | null;
  isbn?: string | null;
}

export interface RefreshOptions {
  /** Folder (or file) that changed; without it the whole library is refreshed. */
  path?: string;
  /**
   * Limits a Plex refresh to sections of this type (`audiobook` looks in music sections).
   * Without it Plex considers movie and show sections only.
   */
  mediaType?: MediaKind;
  /** Jellyfin/Emby partial refresh: what happened to `path`. Default `Modified`. */
  updateType?: 'Created' | 'Modified' | 'Deleted';
}

/** The read client every server kind implements. */
export interface MediaServerClient {
  readonly kind: MediaServerKind;
  /** Server name and version; doubles as the connection test. */
  info(): Promise<ServerInfo>;
  libraries(): Promise<MediaServerLibrary[]>;
  users(): Promise<MediaServerUser[]>;
  /** Every movie or series on the server with its provider ids (cached per client instance). */
  listItems(mediaType: MediaKind): Promise<MediaServerItem[]>;
  /** Items whose TMDB, TVDB or IMDb id matches any id in the query (ids verified client-side). */
  findItems(query: FindItemsQuery): Promise<MediaServerItem[]>;
  /** One user's play state for one item. */
  playState(item: Pick<MediaServerItem, 'id' | 'mediaType'>, userId: string): Promise<PlayState>;
  /** Play state of every movie or series for one user, in as few requests as the server allows. */
  listPlayStates(userId: string, mediaType: MediaKind): Promise<ItemPlayState[]>;
  /** Ask the server to rescan `path`, or everything. */
  refreshLibrary(options?: RefreshOptions): Promise<void>;
}

export type MediaServerErrorCode =
  | 'invalidSettings'
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'notFound'
  | 'rateLimited'
  | 'remoteError';

export class MediaServerError extends Error {
  readonly code: MediaServerErrorCode;
  readonly server: MediaServerKind;
  readonly status: number | undefined;

  constructor(server: MediaServerKind, code: MediaServerErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MediaServerError';
    this.server = server;
    this.code = code;
    this.status = options.status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MediaServerClientOptions {
  kind: MediaServerKind;
  /** Base URL including any URL base, e.g. http://jellyfin.lan:8096/jf. */
  url: string;
  /** Jellyfin/Emby API key, or the Plex owner's X-Plex-Token. */
  apiKey: string;
  fetch?: FetchLike;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
}
