import { z } from 'zod';

// Arclight's own player (the /player portal): music and audiobooks first, video later.
// Plan: "Arclight media player plan" (phases 0 and 1). Routes live under /api/v1/playback
// (browse, progress, queue, bookmarks, playlists) and /api/v1/stream (the media bytes).
// Everything a player user sees is limited to items that have files on disk.

// ---------------------------------------------------------------------------------------
// Access and settings
// ---------------------------------------------------------------------------------------

/**
 * Who serves the audio bytes. `arclight`: Arclight reads the file and transcodes with its own
 * ffmpeg. `jellyfin`: Arclight finds the file's item on a configured Jellyfin or Emby server
 * (by path) and proxies that server's audio stream; Arclight's access rules, signed links and
 * bitrate caps still apply, and the server's API key never reaches the client. A file the server
 * cannot find, or a server that is down, falls back to Arclight's own engine.
 */
export const PlaybackEngine = z.enum(['arclight', 'jellyfin']);
export type PlaybackEngine = z.infer<typeof PlaybackEngine>;

/**
 * Settings section `player` (GET/PUT /settings/player). The player is a preview: off until an
 * admin turns it on. Remote streaming (outside the home network) stays off until an admin allows it.
 */
export const PlayerSettings = z.object({
  enabled: z.boolean().default(false),
  /** Streams from outside the home network (auth/network.ts decides LAN vs remote). */
  allowRemote: z.boolean().default(false),
  /** Cap for remote streams; above it audio is transcoded. 0: no cap. */
  remoteMaxBitrateKbps: z.number().int().min(0).max(100_000).default(320),
  /** Signed stream links (cast, native players, downloads) stay valid this long. */
  streamLinkHours: z.number().int().min(1).max(72).default(6),
  /** Playback engine (see PlaybackEngine). */
  backend: PlaybackEngine.default('arclight'),
  /**
   * With `backend: 'jellyfin'`: the id of the Jellyfin or Emby connection (Settings → Media
   * servers) to stream through. null: the first enabled Jellyfin/Emby connection.
   */
  jellyfinServerId: z.string().max(100).nullable().default(null),
  /** Movies & TV in the player (needs `enabled`). */
  video: z.boolean().default(true),
  /** Live video remuxes/transcodes running at once, server-wide (direct play is not counted). */
  videoMaxStreams: z.number().int().min(1).max(32).default(3),
  /** Live video remuxes/transcodes one user may run at once. */
  videoMaxStreamsPerUser: z.number().int().min(1).max(32).default(1),
});
export type PlayerSettings = z.infer<typeof PlayerSettings>;
export type PlayerSettingsInput = z.input<typeof PlayerSettings>;

/** POST /settings/player/engine-test: checks a Jellyfin/Emby server for the player (unsaved choice). */
export const PlayerEngineTestRequest = z.object({ jellyfinServerId: z.string().max(100).nullable().default(null) });
export type PlayerEngineTestRequest = z.input<typeof PlayerEngineTestRequest>;
export const PlayerEngineTestResult = z.object({
  ok: z.boolean(),
  /** The connection that was tested, when one was found. */
  serverId: z.string().nullable(),
  serverName: z.string().nullable(),
  version: z.string().nullable(),
  /** One audio file Arclight has, and whether the server knows it. null: no audio files yet. */
  sample: z.object({ fileId: z.number().int(), resolved: z.boolean(), itemId: z.string().nullable() }).nullable(),
  /** Why it failed (or a note when the sample did not resolve). */
  message: z.string().nullable(),
});
export type PlayerEngineTestResult = z.infer<typeof PlayerEngineTestResult>;

/**
 * Per-user player access, stored in `users.settings.player` and managed by admins (Users → edit
 * user); listed in ADMIN_MANAGED_USER_SETTINGS. Admins always may play. Absent: no access.
 */
export const PlayerAccess = z.object({
  allowed: z.boolean().default(false),
  /** Remote streaming for this user, on top of the server-wide `allowRemote`. */
  allowRemote: z.boolean().default(true),
  /** Per-user bitrate cap in kbps (0: the server default). */
  maxBitrateKbps: z.number().int().min(0).max(100_000).default(0),
});
export type PlayerAccess = z.infer<typeof PlayerAccess>;

/** GET /playback/me: what the signed-in user may do in the player. */
export const PlayerCapabilities = z.object({
  enabled: z.boolean(),
  allowed: z.boolean(),
  /** This request came from outside the home network. */
  remote: z.boolean(),
  /** May stream right now (allowed, and remote streaming permitted when remote). */
  canStream: z.boolean(),
  /** Effective cap in kbps for this request; 0: none. */
  maxBitrateKbps: z.number().int(),
  /** The engine in effect: `jellyfin` when it is chosen and a Jellyfin/Emby server is set up. */
  engine: PlaybackEngine.optional(),
  sections: z.object({ music: z.boolean(), audiobooks: z.boolean(), podcasts: z.boolean(), books: z.boolean(), video: z.boolean() }),
});
export type PlayerCapabilities = z.infer<typeof PlayerCapabilities>;

// ---------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------

/**
 * Playable item keys, the watch-history scheme (`movie:<movies.id>`, `episode:<episodes.id>`)
 * plus `track:<tracks.id>` and `audiobook:<books.id>`. An audiobook is one item however many files
 * it spans. Later phases add `podcast-episode:`, `ebook:`, `comic-issue:`.
 */
export const PlayableKind = z.enum(['track', 'audiobook', 'movie', 'episode']);
export type PlayableKind = z.infer<typeof PlayableKind>;
export const ItemKey = z.string().regex(/^(track|audiobook|movie|episode):[1-9][0-9]*$/);
export type ItemKey = z.infer<typeof ItemKey>;

export function itemKey(kind: PlayableKind, id: number): ItemKey {
  return `${kind}:${id}`;
}
export function parseItemKey(key: string): { kind: PlayableKind; id: number } | null {
  const m = /^(track|audiobook|movie|episode):([1-9][0-9]*)$/.exec(key);
  return m ? { kind: m[1] as PlayableKind, id: Number(m[2]) } : null;
}
/** Movies and episodes play through the video routes (POST /playback/video/session). */
export function isVideoKind(kind: PlayableKind): kind is 'movie' | 'episode' {
  return kind === 'movie' || kind === 'episode';
}

/** One file of a playable item, placed on the item's timeline. */
export const PlayablePart = z.object({
  /** audio_files.id; stream it from GET /stream/audio/:fileId. */
  fileId: z.number().int(),
  startMs: z.number().int(),
  durationMs: z.number().int(),
  codec: z.string().nullable(),
  container: z.string().nullable(),
  /** MIME type for the original file (audio/flac, audio/mp4, ...). */
  mimeType: z.string(),
  bitrateKbps: z.number().int().nullable(),
  sampleRateHz: z.number().int().nullable(),
  bitDepth: z.number().int().nullable(),
  channels: z.number().int().nullable(),
  sizeBytes: z.number().int(),
});
export type PlayablePart = z.infer<typeof PlayablePart>;

export const PlayableChapter = z.object({ title: z.string(), startMs: z.number().int(), durationMs: z.number().int() });
export type PlayableChapter = z.infer<typeof PlayableChapter>;

// ---------------------------------------------------------------------------------------
// Video (movies and episodes)
// ---------------------------------------------------------------------------------------

export const VideoDynamicRange = z.enum(['sdr', 'hdr10', 'hdr10plus', 'hlg', 'dv']);
export type VideoDynamicRange = z.infer<typeof VideoDynamicRange>;

/** One audio track of a video file. `index` is its ordinal among the file's audio streams (0-based). */
export const VideoAudioTrack = z.object({
  index: z.number().int().min(0),
  codec: z.string(),
  channels: z.number().int().nullable(),
  /** ISO 639-2 as tagged (`eng`); null when untagged. */
  language: z.string().nullable(),
  title: z.string().nullable(),
  default: z.boolean(),
});
export type VideoAudioTrack = z.infer<typeof VideoAudioTrack>;

/**
 * One subtitle track. `id`: `e<ordinal>` for an embedded stream (ordinal among the file's
 * subtitle streams, 0-based) or `x<subtitle_files.id>` for an external file. `text`: srt, ass,
 * vtt, mov_text (served as WebVTT); false for image subtitles (PGS, VobSub), which can only be burned in.
 */
export const VideoSubtitleTrack = z.object({
  id: z.string().regex(/^(e[0-9]+|x[1-9][0-9]*)$/),
  source: z.enum(['embedded', 'external']),
  codec: z.string(),
  language: z.string().nullable(),
  title: z.string().nullable(),
  forced: z.boolean(),
  hearingImpaired: z.boolean(),
  default: z.boolean(),
  text: z.boolean(),
});
export type VideoSubtitleTrack = z.infer<typeof VideoSubtitleTrack>;

/** The file a video item plays (the chosen version), from its ffprobe media info. */
export const VideoInfo = z.object({
  mediaFileId: z.number().int(),
  versionTag: z.string().nullable(),
  /** Short container name: mp4, mkv, webm, mov, avi, ts, ... */
  container: z.string(),
  /** Probe codec id: h264, hevc, av1, vp9, mpeg2video, ... */
  videoCodec: z.string(),
  videoProfile: z.string().nullable(),
  bitDepth: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  fps: z.number().nullable(),
  dynamicRange: VideoDynamicRange,
  sizeBytes: z.number().int(),
  bitrateKbps: z.number().int().nullable(),
  audioTracks: z.array(VideoAudioTrack),
  subtitleTracks: z.array(VideoSubtitleTrack),
});
export type VideoInfo = z.infer<typeof VideoInfo>;

/** One version of a movie or episode (several files: 4K HDR and 1080p, editions). */
export const VideoVersion = z.object({
  versionTag: z.string().nullable(),
  /** "4K HDR", "1080p", "720p · Director's Cut". */
  label: z.string(),
  mediaFileId: z.number().int(),
});
export type VideoVersion = z.infer<typeof VideoVersion>;

/** Intro/credits/recap ranges, from chapter names in the file ("Intro", "Opening", "Credits", "Recap" ...). */
export const VideoSegment = z.object({
  type: z.enum(['intro', 'credits', 'recap']),
  startMs: z.number().int(),
  endMs: z.number().int(),
});
export type VideoSegment = z.infer<typeof VideoSegment>;

/** GET /playback/item/:itemKey. Everything a player needs to start an item. */
export const PlayableItem = z.object({
  itemKey: ItemKey,
  kind: PlayableKind,
  title: z.string(),
  /** Track: artist; audiobook: author(s). */
  subtitle: z.string().nullable(),
  /** Track: album title; audiobook: series and position ("Series, book 2"). */
  context: z.string().nullable(),
  /** Image URL the browser can load (same-origin, cookie auth). */
  artworkUrl: z.string().nullable(),
  durationMs: z.number().int(),
  /**
   * Tracks: one part. Audiobooks: every file in order (part/disc/track), on one timeline.
   * Movies and episodes: empty (they play through `video`).
   */
  parts: z.array(PlayablePart),
  /** Audiobooks: chapters on the whole-book timeline. Video: the file's chapters. Tracks: empty. */
  chapters: z.array(PlayableChapter),
  /** Links back for the UI. */
  albumId: z.number().int().nullable(),
  artistId: z.number().int().nullable(),
  bookId: z.number().int().nullable(),
  /** ReplayGain from tags when present (dB). */
  replayGain: z.object({ trackGainDb: z.number().nullable(), albumGainDb: z.number().nullable() }).nullable(),
  // ---- movies and episodes only ------------------------------------------------------
  movieId: z.number().int().optional(),
  seriesId: z.number().int().optional(),
  seasonNumber: z.number().int().optional(),
  episodeNumber: z.number().int().optional(),
  year: z.number().int().nullable().optional(),
  overview: z.string().nullable().optional(),
  /** Wide artwork (movie/series fanart) for the player background. */
  backdropUrl: z.string().nullable().optional(),
  /** Title logo (clearlogo) when known. */
  logoUrl: z.string().nullable().optional(),
  /** The file that plays by default (the best version) and its tracks. */
  video: VideoInfo.optional(),
  /** Every version with a file, best first. */
  versions: z.array(VideoVersion).optional(),
  segments: z.array(VideoSegment).optional(),
  /** Episodes: the next / previous episode with a file (up next, auto-play). */
  next: ItemKey.optional(),
  previous: ItemKey.optional(),
});
export type PlayableItem = z.infer<typeof PlayableItem>;

// ---------------------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------------------

/**
 * GET /stream/audio/:fileId streams the original file with HTTP range support (206), or, with
 * `?format=aac|opus&bitrateKbps=`, a live ffmpeg transcode (no ranges; seek with `?startMs=`).
 * Auth: the session cookie, or a signed link from POST /playback/stream-links (`?sig=&exp=&u=`).
 * The server transcodes on its own when the request is remote and the file is over the cap.
 */
export const StreamFormat = z.enum(['original', 'aac', 'opus', 'mp3']);
export type StreamFormat = z.infer<typeof StreamFormat>;

export const StreamQuery = z.object({
  format: StreamFormat.default('original'),
  bitrateKbps: z.coerce.number().int().min(32).max(512).optional(),
  startMs: z.coerce.number().int().min(0).optional(),
  /**
   * `1`: answer with `Content-Disposition: attachment` and a safe file name (downloads for
   * offline play). With a `format`, the whole file is transcoded from the start (no ranges).
   */
  download: z.enum(['0', '1', 'true', 'false']).optional(),
});
export type StreamQuery = z.infer<typeof StreamQuery>;

export const StreamLinksRequest = z.object({
  itemKey: ItemKey,
  format: StreamFormat.default('original'),
  bitrateKbps: z.number().int().min(32).max(512).optional(),
  /** Links that download (`&download=1`: Content-Disposition attachment). */
  download: z.boolean().default(false),
});
export const StreamLink = z.object({
  fileId: z.number().int(),
  url: z.string(),
  expiresAt: z.string(),
  /** Who serves this file's bytes right now (the Jellyfin item resolved, or Arclight's own engine). */
  backend: PlaybackEngine.optional(),
});
export const StreamLinksResponse = z.object({
  links: z.array(StreamLink),
  /** `jellyfin` when every part streams through Jellyfin/Emby; otherwise `arclight`. */
  backendInUse: PlaybackEngine.optional(),
});
export type StreamLinksRequest = z.infer<typeof StreamLinksRequest>;
export type StreamLink = z.infer<typeof StreamLink>;
export type StreamLinksResponse = z.infer<typeof StreamLinksResponse>;

/** POST /playback/items: several playable items at once (queues, offline downloads). */
export const PLAYBACK_ITEMS_MAX = 200;
export const PlaybackItemsRequest = z.object({ itemKeys: z.array(ItemKey).min(1).max(PLAYBACK_ITEMS_MAX) });
export type PlaybackItemsRequest = z.infer<typeof PlaybackItemsRequest>;

/**
 * POST /playback/artwork-link: a query string (`u=&exp=&sig=`) that lets image loaders without
 * credentials (an <img> in the app, a cast receiver) fetch any GET /playback/artwork/:kind/:id.
 */
export const ArtworkLinkResponse = z.object({ query: z.string(), expiresAt: z.string() });
export type ArtworkLinkResponse = z.infer<typeof ArtworkLinkResponse>;

// ---------------------------------------------------------------------------------------
// Progress (playback_progress, keyed on Arclight user + item key)
// ---------------------------------------------------------------------------------------

/** Over this share of the duration an item counts as played (matches Jellyfin's default). */
export const PLAYED_THRESHOLD = 0.9;
/** Under this share there is nothing to resume. */
export const RESUME_MIN = 0.02;

export const ItemPrefs = z.object({
  /** Playback speed, remembered per audiobook. */
  speed: z.number().min(0.5).max(3.5).optional(),
});
export type ItemPrefs = z.infer<typeof ItemPrefs>;

export const PlaybackProgress = z.object({
  itemKey: ItemKey,
  positionMs: z.number().int(),
  durationMs: z.number().int(),
  played: z.boolean(),
  playCount: z.number().int(),
  lastPlayedAt: z.string().nullable(),
  updatedAt: z.string(),
  favorite: z.boolean(),
  prefs: ItemPrefs,
  /** Where the newest position came from: this player, or a linked media server account. */
  source: z.enum(['arclight', 'jellyfin', 'emby', 'plex', 'audiobookshelf']),
});
export type PlaybackProgress = z.infer<typeof PlaybackProgress>;

/**
 * PUT /playback/progress/:itemKey, and POST /playback/progress/beacon (sendBeacon: text/plain
 * JSON with `itemKey` added). Send `start` once, `progress` every 10-15 s, `pause`/`seek` when
 * they happen and `stop` on close. Reports older than the stored one (by `clientTime`) are ignored.
 */
export const ProgressReport = z.object({
  event: z.enum(['start', 'progress', 'pause', 'seek', 'stop']),
  positionMs: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  speed: z.number().min(0.5).max(3.5).optional(),
  /** Stable per browser/app install (random, kept in local storage). */
  deviceId: z.string().min(1).max(64),
  deviceName: z.string().max(100).optional(),
  /** ISO time on the device when the report was made (offline queues send late). */
  clientTime: z.string(),
  playMethod: z.enum(['DirectPlay', 'Transcode']).optional(),
});
export type ProgressReport = z.infer<typeof ProgressReport>;
export const ProgressBeacon = ProgressReport.extend({ itemKey: ItemKey });
export type ProgressBeacon = z.infer<typeof ProgressBeacon>;

/**
 * POST /playback/progress/batch: reports queued while offline. Applied oldest `clientTime` first
 * with the single-report rules (a report older than the stored row is ignored).
 */
export const PROGRESS_BATCH_MAX = 500;
export const ProgressBatchRequest = z.object({ reports: z.array(ProgressBeacon).min(1).max(PROGRESS_BATCH_MAX) });
export type ProgressBatchRequest = z.infer<typeof ProgressBatchRequest>;
/** One result per report, in request order; `progress` is the stored row afterwards. */
export const ProgressBatchResponse = z.object({
  results: z.array(z.object({ itemKey: ItemKey, accepted: z.boolean(), progress: PlaybackProgress })),
});
export type ProgressBatchResponse = z.infer<typeof ProgressBatchResponse>;

/** PATCH /playback/progress/:itemKey: mark played/unplayed, favourite, per-item prefs. */
export const ProgressUpdate = z.object({
  played: z.boolean().optional(),
  favorite: z.boolean().optional(),
  prefs: ItemPrefs.optional(),
});
export type ProgressUpdate = z.infer<typeof ProgressUpdate>;

/** GET /playback/progress?itemKeys=a,b,c (max 200): effective progress, newest source wins. */
export const ProgressQuery = z.object({ itemKeys: z.string().max(8000) });
export const ProgressListResponse = z.object({ items: z.array(PlaybackProgress) });
export type ProgressListResponse = z.infer<typeof ProgressListResponse>;

// ---------------------------------------------------------------------------------------
// Queue (one per user, carries on between devices)
// ---------------------------------------------------------------------------------------

export const RepeatMode = z.enum(['off', 'all', 'one']);
export type RepeatMode = z.infer<typeof RepeatMode>;

/** GET/PUT /playback/queue. `order` is the shuffled play order (indexes into `items`) when shuffled. */
export const PlayQueue = z.object({
  items: z.array(ItemKey).max(5000),
  /** Index into `items` (not into `order`) of the item playing now. */
  index: z.number().int().min(0),
  positionMs: z.number().int().min(0),
  shuffle: z.boolean(),
  order: z.array(z.number().int().min(0)).max(5000).nullable(),
  repeat: RepeatMode,
  /** What the queue was started from, for "Playing from ..." ("album:12", "playlist:3", "audiobook:7"). */
  source: z.string().max(100).nullable(),
  updatedAt: z.string().optional(),
  deviceId: z.string().max(64).optional(),
});
export type PlayQueue = z.infer<typeof PlayQueue>;

// ---------------------------------------------------------------------------------------
// Bookmarks (audiobooks)
// ---------------------------------------------------------------------------------------

export const Bookmark = z.object({
  id: z.number().int(),
  itemKey: ItemKey,
  positionMs: z.number().int(),
  note: z.string().max(2000),
  createdAt: z.string(),
});
export type Bookmark = z.infer<typeof Bookmark>;
/** GET /playback/bookmarks?itemKey=, POST /playback/bookmarks, PUT/DELETE /playback/bookmarks/:id. */
export const BookmarkInput = z.object({ itemKey: ItemKey, positionMs: z.number().int().min(0), note: z.string().max(2000).default('') });
export type BookmarkInput = z.input<typeof BookmarkInput>;
export const BookmarkListQuery = z.object({ itemKey: ItemKey });
/** PUT /playback/bookmarks/:id: move a bookmark or change its note. */
export const BookmarkUpdate = z.object({ positionMs: z.number().int().min(0).optional(), note: z.string().max(2000).optional() });
export type BookmarkUpdate = z.infer<typeof BookmarkUpdate>;

// ---------------------------------------------------------------------------------------
// User playlists (the player's own; separate from the music module's synced playlists)
// ---------------------------------------------------------------------------------------

export const UserPlaylistSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  trackCount: z.number().int(),
  durationMs: z.number().int(),
  /** Up to four album covers for a mosaic. */
  artworkUrls: z.array(z.string()).max(4),
  updatedAt: z.string(),
});
export type UserPlaylistSummary = z.infer<typeof UserPlaylistSummary>;

/** A user playlist holds at most this many entries. */
export const MAX_PLAYLIST_TRACKS = 5000;

/**
 * GET/POST /playback/playlists, GET/PUT/DELETE /playback/playlists/:id. PUT with `trackIds`
 * replaces every entry (send the raw `trackIds` of GET to keep tracks that have no file yet);
 * editors should prefer the incremental /tracks routes below, which cannot lose a concurrent edit.
 */
export const UserPlaylistInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  /** Track ids in order. Duplicates are allowed. */
  trackIds: z.array(z.number().int()).max(MAX_PLAYLIST_TRACKS).optional(),
});
export type UserPlaylistInput = z.infer<typeof UserPlaylistInput>;

/** POST /playback/playlists/:id/tracks: insert tracks at `position` (an index into `trackIds`; default: the end). */
export const PlaylistTracksAdd = z.object({
  trackIds: z.array(z.number().int().positive()).min(1).max(MAX_PLAYLIST_TRACKS),
  position: z.number().int().min(0).optional(),
});
export type PlaylistTracksAdd = z.infer<typeof PlaylistTracksAdd>;

/** PATCH /playback/playlists/:id/tracks/:entryId: move the entry next to another one. */
export const PlaylistTrackMove = z
  .object({ beforeEntryId: z.number().int().positive().optional(), afterEntryId: z.number().int().positive().optional() })
  .refine((v) => (v.beforeEntryId === undefined) !== (v.afterEntryId === undefined), { message: 'give exactly one of beforeEntryId, afterEntryId' });
export type PlaylistTrackMove = z.infer<typeof PlaylistTrackMove>;

// ---------------------------------------------------------------------------------------
// Browse (/playback/music/..., /playback/audiobooks/...): only items with files
// ---------------------------------------------------------------------------------------

export const PlayerTrack = z.object({
  id: z.number().int(),
  itemKey: ItemKey,
  title: z.string(),
  artistName: z.string(),
  artistId: z.number().int(),
  albumTitle: z.string(),
  albumId: z.number().int(),
  discNumber: z.number().int().nullable(),
  trackNumber: z.number().int().nullable(),
  durationMs: z.number().int(),
  /** "FLAC 24/96", "MP3 320", "AAC 256". */
  formatLabel: z.string().nullable(),
  /** Lossless original (FLAC, ALAC, WAV). */
  lossless: z.boolean(),
  artworkUrl: z.string().nullable(),
  explicit: z.boolean(),
});
export type PlayerTrack = z.infer<typeof PlayerTrack>;

export const PlayerAlbum = z.object({
  id: z.number().int(),
  title: z.string(),
  artistName: z.string(),
  artistId: z.number().int(),
  year: z.number().int().nullable(),
  albumType: z.string().nullable(),
  trackCount: z.number().int(),
  durationMs: z.number().int(),
  formatLabel: z.string().nullable(),
  lossless: z.boolean(),
  artworkUrl: z.string().nullable(),
  addedAt: z.string().nullable(),
  genres: z.array(z.string()),
});
export type PlayerAlbum = z.infer<typeof PlayerAlbum>;
export const PlayerAlbumDetails = PlayerAlbum.extend({ tracks: z.array(PlayerTrack), discCount: z.number().int() });
export type PlayerAlbumDetails = z.infer<typeof PlayerAlbumDetails>;

export const PlayerArtist = z.object({
  id: z.number().int(),
  name: z.string(),
  imageUrl: z.string().nullable(),
  albumCount: z.number().int(),
  trackCount: z.number().int(),
  genres: z.array(z.string()),
});
export type PlayerArtist = z.infer<typeof PlayerArtist>;
export const PlayerArtistDetails = PlayerArtist.extend({
  overview: z.string().nullable(),
  /** From this user's play counts; falls back to album order when nothing was played. */
  topTracks: z.array(PlayerTrack).max(10),
  albums: z.array(PlayerAlbum),
});
export type PlayerArtistDetails = z.infer<typeof PlayerArtistDetails>;

/** GET /playback/music/home. */
export const MusicHome = z.object({
  recentlyPlayed: z.array(PlayerTrack),
  jumpBackIn: z.array(PlayerAlbum),
  recentlyAdded: z.array(PlayerAlbum),
  playlists: z.array(UserPlaylistSummary),
  onThisDay: z.array(PlayerAlbum),
});
export type MusicHome = z.infer<typeof MusicHome>;

export const BrowseSort = z.enum(['name', 'added', 'played', 'year', 'artist']);
export type BrowseSort = z.infer<typeof BrowseSort>;
/** GET /playback/music/albums | /artists | /tracks. */
export const BrowseQuery = z.object({
  search: z.string().max(200).optional(),
  sort: BrowseSort.default('name'),
  desc: z.union([z.boolean(), z.stringbool()]).default(false),
  genre: z.string().max(100).optional(),
  /** First letter for the A-Z rail ("#" for digits and symbols). */
  letter: z.string().max(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(60),
});
export type BrowseQuery = z.infer<typeof BrowseQuery>;
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() });
}
export const PlayerAlbumPage = pageOf(PlayerAlbum);
export const PlayerArtistPage = pageOf(PlayerArtist);
export const PlayerTrackPage = pageOf(PlayerTrack);
export type PlayerAlbumPage = z.infer<typeof PlayerAlbumPage>;
export type PlayerArtistPage = z.infer<typeof PlayerArtistPage>;
export type PlayerTrackPage = z.infer<typeof PlayerTrackPage>;

export const UserPlaylistDetails = UserPlaylistSummary.extend({
  /** The entries that can play (their track has a file), in order. */
  tracks: z.array(PlayerTrack),
  /** Entry id of each of `tracks` (same order): what the /tracks/:entryId routes take. */
  entryIds: z.array(z.number().int()),
  /** Every entry's track id in order, including tracks without a file yet. */
  trackIds: z.array(z.number().int()),
});
export type UserPlaylistDetails = z.infer<typeof UserPlaylistDetails>;

/** GET /playback/search?q= (music and audiobooks together, typo tolerant). */
export const PlayerAudiobook = z.object({
  id: z.number().int(),
  itemKey: ItemKey,
  title: z.string(),
  authors: z.array(z.string()),
  narrators: z.array(z.string()),
  seriesTitle: z.string().nullable(),
  seriesPosition: z.string().nullable(),
  durationMs: z.number().int(),
  artworkUrl: z.string().nullable(),
  addedAt: z.string().nullable(),
  /** This user's effective progress, when any. */
  progress: PlaybackProgress.nullable(),
});
export type PlayerAudiobook = z.infer<typeof PlayerAudiobook>;
export const PlayerAudiobookDetails = PlayerAudiobook.extend({
  description: z.string().nullable(),
  chapters: z.array(PlayableChapter),
  /** Other books in the same series that have files, in reading order. */
  series: z.array(PlayerAudiobook),
});
export type PlayerAudiobookDetails = z.infer<typeof PlayerAudiobookDetails>;

export const PlayerSearchResponse = z.object({
  tracks: z.array(PlayerTrack),
  albums: z.array(PlayerAlbum),
  artists: z.array(PlayerArtist),
  audiobooks: z.array(PlayerAudiobook),
  /** Movies and shows with files (empty when Movies & TV is off for this user). */
  movies: z.array(z.lazy(() => PlayerMovie)),
  series: z.array(z.lazy(() => PlayerSeries)),
});
export type PlayerSearchResponse = z.infer<typeof PlayerSearchResponse>;

/** GET /playback/audiobooks/home. */
export const AudiobookHome = z.object({
  continueListening: z.array(PlayerAudiobook),
  recentlyAdded: z.array(PlayerAudiobook),
  /** Series with at least one book, books in reading order. */
  series: z.array(z.object({ id: z.number().int(), title: z.string(), books: z.array(PlayerAudiobook) })),
  finished: z.array(PlayerAudiobook),
});
export type AudiobookHome = z.infer<typeof AudiobookHome>;
/** GET /playback/audiobooks (BrowseQuery; sort `artist` means author). */
export const PlayerAudiobookPage = pageOf(PlayerAudiobook);
export type PlayerAudiobookPage = z.infer<typeof PlayerAudiobookPage>;

/** GET /playback/continue: the newest unfinished items of any kind, for the player home. */
export const ContinueResponse = z.object({
  items: z.array(z.object({ item: PlayableItem, progress: PlaybackProgress })),
});
export type ContinueResponse = z.infer<typeof ContinueResponse>;

// ---------------------------------------------------------------------------------------
// Video playback: device profile, session, streams
// ---------------------------------------------------------------------------------------

/**
 * What a client can play natively. Web builds it from MediaSource.isTypeSupported/canPlayType,
 * Android from MediaCodecList and the display/audio capabilities.
 */
export const VideoDeviceProfile = z.object({
  /** mp4, mkv, webm, mov. */
  containers: z.array(z.string().max(20)).max(20),
  /** h264, hevc, av1, vp9. */
  videoCodecs: z.array(z.string().max(20)).max(20),
  /** HEVC Main 10 decodes. */
  hevc10bit: z.boolean().default(false),
  hdr: z.array(z.enum(['hdr10', 'hlg', 'dv'])).max(3).default([]),
  /** aac, mp3, opus, flac, ac3, eac3, dts, truehd. */
  audioCodecs: z.array(z.string().max(20)).max(20),
  maxAudioChannels: z.number().int().min(1).max(16).default(2),
  maxHeight: z.number().int().min(144).max(4320).default(1080),
  maxBitrateKbps: z.number().int().min(100).max(1_000_000).optional(),
});
export type VideoDeviceProfile = z.infer<typeof VideoDeviceProfile>;
export type VideoDeviceProfileInput = z.input<typeof VideoDeviceProfile>;

export const VideoPlayMethod = z.enum(['direct', 'remux', 'transcode']);
export type VideoPlayMethod = z.infer<typeof VideoPlayMethod>;
export const VideoQuality = z.enum(['auto', 'original', '1080p', '720p', '480p']);
export type VideoQuality = z.infer<typeof VideoQuality>;

/**
 * Why a session is not direct play (`VideoSession.reasons`; clients translate the codes):
 * container, video-codec, video-profile (10-bit HEVC on a device without Main 10, ...),
 * audio-codec, audio-channels, hdr (HDR file, SDR device: tone-mapped), resolution (over
 * maxHeight or the chosen quality), bitrate (over the device/user/remote cap), burn-subtitle (an
 * image subtitle was chosen), quality (the user picked a lower quality).
 */
export const VIDEO_REASONS = [
  'container',
  'video-codec',
  'video-profile',
  'audio-codec',
  'audio-channels',
  'hdr',
  'resolution',
  'bitrate',
  'burn-subtitle',
  'quality',
] as const;
export const VideoReason = z.enum(VIDEO_REASONS);
export type VideoReason = z.infer<typeof VideoReason>;

/** POST /playback/video/session. Call again (with `startMs`) to seek in a stream that is not seekable. */
export const VideoSessionRequest = z.object({
  itemKey: ItemKey,
  /** A version (media_files.id) of the item; default: the item's best version. */
  mediaFileId: z.number().int().positive().optional(),
  profile: VideoDeviceProfile,
  /** Audio ordinal (VideoAudioTrack.index); default: the file's default track. */
  audioTrack: z.number().int().min(0).optional(),
  /** VideoSubtitleTrack.id; an image subtitle here is burned in (transcode). null/absent: none. */
  subtitle: z.string().max(20).nullable().optional(),
  /** Media time to start at (remux/transcode begin here; direct play seeks there itself). */
  startMs: z.number().int().min(0).optional(),
  quality: VideoQuality.default('auto'),
});
export type VideoSessionRequest = z.input<typeof VideoSessionRequest>;

export const VideoSessionSubtitle = z.object({
  id: z.string(),
  label: z.string(),
  language: z.string().nullable(),
  forced: z.boolean(),
  default: z.boolean(),
  /**
   * Absolute signed WebVTT URL (GET /stream/subtitle/:mediaFileId/:subId.vtt). Cue times are
   * always media time: the server never offsets them. With a remux/transcode stream that begins
   * at `streamStartMs`, clients subtract `streamStartMs` from cue times (or add it to the
   * player's clock) themselves.
   */
  url: z.string(),
});
export type VideoSessionSubtitle = z.infer<typeof VideoSessionSubtitle>;

export const VideoSession = z.object({
  itemKey: ItemKey,
  mediaFileId: z.number().int(),
  method: VideoPlayMethod,
  /** Empty for direct play; otherwise VideoReason codes. */
  reasons: z.array(VideoReason),
  /** Absolute signed stream URL (GET /stream/video/:mediaFileId?...). */
  url: z.string(),
  /** video/mp4, video/x-matroska, video/webm, ... (remux/transcode: video/mp4). */
  mimeType: z.string(),
  /** 0 for direct; for remux/transcode the media time the stream's time 0 is at. */
  streamStartMs: z.number().int(),
  /** Byte ranges work (direct only). Otherwise seek by asking for a new session with `startMs`. */
  seekable: z.boolean(),
  durationMs: z.number().int(),
  /** The audio ordinal that plays. */
  audioTrack: z.number().int(),
  /** Text subtitle tracks as WebVTT (image subtitles are never listed here). */
  subtitles: z.array(VideoSessionSubtitle),
  /** The subtitle id burned into the picture, when one is. */
  burnedSubtitle: z.string().nullable(),
  /** When the signed URLs stop working. */
  expiresAt: z.string(),
});
export type VideoSession = z.infer<typeof VideoSession>;

/**
 * GET|HEAD /stream/video/:mediaFileId?u&exp&sig&m=&a=&s=&h=&k=&b=. Signature domain
 * `video:<userId>:<mediaFileId>:<exp>`. `m`: method; `a`: audio ordinal; `s`: start ms
 * (remux/transcode); `h`: max height; `k`: video kbps cap; `b`: subtitle id to burn in.
 */
export const VideoStreamQuery = z.object({
  u: z.coerce.number().int().positive(),
  exp: z.coerce.number().int(),
  sig: z.string().max(200),
  m: VideoPlayMethod.default('direct'),
  a: z.coerce.number().int().min(0).optional(),
  s: z.coerce.number().int().min(0).optional(),
  h: z.coerce.number().int().min(144).max(4320).optional(),
  k: z.coerce.number().int().min(100).max(1_000_000).optional(),
  b: z.string().max(20).optional(),
});
export type VideoStreamQuery = z.infer<typeof VideoStreamQuery>;

// ---------------------------------------------------------------------------------------
// Video browse (/playback/video/home, /playback/movies, /playback/series): only items with files,
// within the user's content restrictions
// ---------------------------------------------------------------------------------------

export const VideoProgress = z.object({ positionMs: z.number().int(), durationMs: z.number().int(), played: z.boolean() });
export type VideoProgress = z.infer<typeof VideoProgress>;

/** GET /playback/artwork/movie|series/:id?type=poster|fanart|logo&w=342|780|1280|original (302 to TMDB). */
export const VideoArtworkType = z.enum(['poster', 'fanart', 'logo']);
export type VideoArtworkType = z.infer<typeof VideoArtworkType>;

export const VideoCard = z.object({
  /** What plays (movie/episode); null for a series card. */
  itemKey: ItemKey.nullable(),
  kind: z.enum(['movie', 'series', 'episode']),
  id: z.number().int(),
  /** Episode: the series title. */
  title: z.string(),
  /** Episode: "S1:E2 · Episode title"; series: network; movie: null. */
  subtitle: z.string().nullable(),
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  backdropUrl: z.string().nullable(),
  /** Episode frame thumbnail (16:9). */
  thumbUrl: z.string().nullable(),
  progress: VideoProgress.nullable(),
  seriesId: z.number().int().optional(),
  seasonNumber: z.number().int().optional(),
  episodeNumber: z.number().int().optional(),
  /** '4K', 'HDR', 'DV'. */
  badges: z.array(z.string()),
});
export type VideoCard = z.infer<typeof VideoCard>;

/** GET /playback/video/home. */
export const VideoHome = z.object({
  continueWatching: z.array(VideoCard),
  /** Per series watched in the last 60 days: the first unplayed episode with a file after the last played one. */
  nextUp: z.array(VideoCard),
  recentMovies: z.array(VideoCard),
  recentEpisodes: z.array(VideoCard),
  /** Genres of the movies and shows that have files. */
  genres: z.array(z.string()),
});
export type VideoHome = z.infer<typeof VideoHome>;

/** GET /playback/movies and /playback/series. */
export const VideoBrowseQuery = z.object({
  search: z.string().max(200).optional(),
  sort: z.enum(['title', 'added', 'year', 'rating']).default('title'),
  order: z.enum(['asc', 'desc']).default('asc'),
  genre: z.string().max(100).optional(),
  /** First letter of the sort title ("#" for digits and symbols). */
  letter: z.string().max(1).optional(),
  watched: z.enum(['all', 'unwatched', 'watched']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(60),
});
export type VideoBrowseQuery = z.infer<typeof VideoBrowseQuery>;
export type VideoBrowseQueryInput = z.input<typeof VideoBrowseQuery>;

export const PlayerMovie = z.object({
  id: z.number().int(),
  itemKey: ItemKey,
  title: z.string(),
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  backdropUrl: z.string().nullable(),
  runtimeMinutes: z.number().int().nullable(),
  certification: z.string().nullable(),
  /** TMDB (else IMDb) rating, 0-10. */
  rating: z.number().nullable(),
  genres: z.array(z.string()),
  addedAt: z.string().nullable(),
  progress: VideoProgress.nullable(),
  played: z.boolean(),
  badges: z.array(z.string()),
});
export type PlayerMovie = z.infer<typeof PlayerMovie>;
export const PlayerMoviePage = pageOf(PlayerMovie);
export type PlayerMoviePage = z.infer<typeof PlayerMoviePage>;

/** A version on a details page. */
export const PlayerVideoVersion = VideoVersion.extend({
  badges: z.array(z.string()),
  /** "HEVC 10-bit · EAC3 5.1 · 2160p". */
  description: z.string().nullable(),
  sizeBytes: z.number().int(),
  audioLanguages: z.array(z.string()),
  subtitleLanguages: z.array(z.string()),
});
export type PlayerVideoVersion = z.infer<typeof PlayerVideoVersion>;

/** GET /playback/movies/:id. */
export const PlayerMovieDetails = PlayerMovie.extend({
  originalTitle: z.string().nullable(),
  overview: z.string().nullable(),
  logoUrl: z.string().nullable(),
  ratings: z.object({ tmdb: z.number().nullable(), imdb: z.number().nullable(), rottenTomatoes: z.number().nullable() }),
  studio: z.string().nullable(),
  collection: z.string().nullable(),
  versions: z.array(PlayerVideoVersion),
});
export type PlayerMovieDetails = z.infer<typeof PlayerMovieDetails>;

export const PlayerSeries = z.object({
  id: z.number().int(),
  title: z.string(),
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  backdropUrl: z.string().nullable(),
  certification: z.string().nullable(),
  rating: z.number().nullable(),
  genres: z.array(z.string()),
  network: z.string().nullable(),
  status: z.string().nullable(),
  addedAt: z.string().nullable(),
  /** Episodes with a file, and of those, played by this user. */
  episodeCount: z.number().int(),
  playedCount: z.number().int(),
  badges: z.array(z.string()),
});
export type PlayerSeries = z.infer<typeof PlayerSeries>;
export const PlayerSeriesPage = pageOf(PlayerSeries);
export type PlayerSeriesPage = z.infer<typeof PlayerSeriesPage>;

export const PlayerEpisode = z.object({
  itemKey: ItemKey,
  id: z.number().int(),
  seasonNumber: z.number().int(),
  episodeNumber: z.number().int(),
  title: z.string().nullable(),
  overview: z.string().nullable(),
  airDate: z.string().nullable(),
  runtimeMinutes: z.number().int().nullable(),
  thumbUrl: z.string().nullable(),
  progress: VideoProgress.nullable(),
  played: z.boolean(),
});
export type PlayerEpisode = z.infer<typeof PlayerEpisode>;

export const PlayerSeason = z.object({
  seasonNumber: z.number().int(),
  /** "Season 1", or "Specials" for season 0 (clients may translate by number). */
  title: z.string(),
  episodeCount: z.number().int(),
  playedCount: z.number().int(),
  /** Episodes with a file, in order. */
  episodes: z.array(PlayerEpisode),
});
export type PlayerSeason = z.infer<typeof PlayerSeason>;

/** GET /playback/series/:id. */
export const PlayerSeriesDetails = PlayerSeries.extend({
  originalTitle: z.string().nullable(),
  overview: z.string().nullable(),
  logoUrl: z.string().nullable(),
  seasons: z.array(PlayerSeason),
  /** What "Play" starts: the in-progress or next unplayed episode; null when every episode is played. */
  nextUp: ItemKey.nullable(),
});
export type PlayerSeriesDetails = z.infer<typeof PlayerSeriesDetails>;

/**
 * POST /playback/watched: mark items, a whole series or one season played/unplayed (writes
 * playback_progress like a finished report). Give `itemKeys`, or `seriesId` (+ `seasonNumber`).
 */
export const VideoWatchedRequest = z
  .object({
    itemKeys: z.array(ItemKey).min(1).max(PLAYBACK_ITEMS_MAX).optional(),
    seriesId: z.number().int().positive().optional(),
    seasonNumber: z.number().int().min(0).optional(),
    played: z.boolean(),
  })
  .refine((v) => (v.itemKeys !== undefined) !== (v.seriesId !== undefined), { message: 'give itemKeys or seriesId' });
export type VideoWatchedRequest = z.infer<typeof VideoWatchedRequest>;
export const VideoWatchedResponse = z.object({ updated: z.number().int() });
export type VideoWatchedResponse = z.infer<typeof VideoWatchedResponse>;
