import { z } from 'zod';

// Arclight's own player (the /player portal): music and audiobooks first, video later.
// Plan: "Arclight media player plan" (phases 0 and 1). Routes live under /api/v1/playback
// (browse, progress, queue, bookmarks, playlists) and /api/v1/stream (the media bytes).
// Everything a player user sees is limited to items that have files on disk.

// ---------------------------------------------------------------------------------------
// Access and settings
// ---------------------------------------------------------------------------------------

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
});
export type PlayerSettings = z.infer<typeof PlayerSettings>;
export type PlayerSettingsInput = z.input<typeof PlayerSettings>;

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
  sections: z.object({ music: z.boolean(), audiobooks: z.boolean(), podcasts: z.boolean(), books: z.boolean(), video: z.boolean() }),
});
export type PlayerCapabilities = z.infer<typeof PlayerCapabilities>;

// ---------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------

/**
 * Playable item keys, extending the watch-history scheme (`movie:<id>`, `episode:<id>`):
 * `track:<tracks.id>` and `audiobook:<books.id>`. An audiobook is one item however many files
 * it spans. Later phases add `podcast-episode:`, `ebook:`, `comic-issue:`.
 */
export const PlayableKind = z.enum(['track', 'audiobook']);
export type PlayableKind = z.infer<typeof PlayableKind>;
export const ItemKey = z.string().regex(/^(track|audiobook):[1-9][0-9]*$/);
export type ItemKey = z.infer<typeof ItemKey>;

export function itemKey(kind: PlayableKind, id: number): ItemKey {
  return `${kind}:${id}`;
}
export function parseItemKey(key: string): { kind: PlayableKind; id: number } | null {
  const m = /^(track|audiobook):([1-9][0-9]*)$/.exec(key);
  return m ? { kind: m[1] as PlayableKind, id: Number(m[2]) } : null;
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
  /** Tracks: one part. Audiobooks: every file in order (part/disc/track), on one timeline. */
  parts: z.array(PlayablePart).min(1),
  /** Audiobooks: chapters on the whole-book timeline. Tracks: empty. */
  chapters: z.array(PlayableChapter),
  /** Links back for the UI. */
  albumId: z.number().int().nullable(),
  artistId: z.number().int().nullable(),
  bookId: z.number().int().nullable(),
  /** ReplayGain from tags when present (dB). */
  replayGain: z.object({ trackGainDb: z.number().nullable(), albumGainDb: z.number().nullable() }).nullable(),
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
});
export type StreamQuery = z.infer<typeof StreamQuery>;

export const StreamLinksRequest = z.object({
  itemKey: ItemKey,
  format: StreamFormat.default('original'),
  bitrateKbps: z.number().int().min(32).max(512).optional(),
});
export const StreamLink = z.object({ fileId: z.number().int(), url: z.string(), expiresAt: z.string() });
export const StreamLinksResponse = z.object({ links: z.array(StreamLink) });
export type StreamLinksRequest = z.infer<typeof StreamLinksRequest>;
export type StreamLink = z.infer<typeof StreamLink>;
export type StreamLinksResponse = z.infer<typeof StreamLinksResponse>;

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

/** GET/POST /playback/playlists, GET/PUT/DELETE /playback/playlists/:id. */
export const UserPlaylistInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  /** Track ids in order. Duplicates are allowed. */
  trackIds: z.array(z.number().int()).max(5000).optional(),
});
export type UserPlaylistInput = z.infer<typeof UserPlaylistInput>;

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

export const UserPlaylistDetails = UserPlaylistSummary.extend({ tracks: z.array(PlayerTrack) });
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
