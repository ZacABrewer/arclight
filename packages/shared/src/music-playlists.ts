import { z } from 'zod';
import { SECRET_MASK } from './settings.js';

// Music playlists and similar artists (docs/using/music-playlists.md). A playlist follows one
// outside source (a Spotify or Deezer playlist link, a ListenBrainz playlist or the newest
// "created for you" playlist of a user, a Last.fm user's top or loved tracks), matches each
// track to a MusicBrainz recording and the library, optionally wants what is missing, and
// writes the result as an .m3u8 file and/or a playlist on Jellyfin, Emby, Plex or Navidrome.
// Routes under /api/v1/music/playlist and /api/v1/settings/musicplaylists, admin-only, 404
// MUSIC_DISABLED while music is off. Similar artists: GET /artist/{id}/similar (library) and
// GET /discover/music/artist/{mbid}/similar (request portal).

// ---------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------

export const LastfmChart = z.enum(['top', 'loved']);
export type LastfmChart = z.infer<typeof LastfmChart>;

export const LastfmPeriodOption = z.enum(['overall', '7day', '1month', '3month', '6month', '12month']);
export type LastfmPeriodOption = z.infer<typeof LastfmPeriodOption>;

export const PlaylistSource = z.discriminatedUnion('kind', [
  /** A playlist link, `spotify:playlist:` URI or id. Needs a Spotify app's client id and secret. */
  z.object({ kind: z.literal('spotify'), url: z.string().trim().min(1).max(500) }),
  /** A public Deezer playlist link or id. */
  z.object({ kind: z.literal('deezer'), url: z.string().trim().min(1).max(500) }),
  /** A ListenBrainz playlist link or MBID. */
  z.object({ kind: z.literal('listenbrainz'), url: z.string().trim().min(1).max(500) }),
  /**
   * The newest ListenBrainz playlist created for a user. `patch` narrows it to one kind
   * (`weekly-jams`, `weekly-exploration`, `daily-jams`, ...); empty takes the newest of any.
   */
  z.object({ kind: z.literal('listenbrainzCreatedFor'), user: z.string().trim().min(1).max(100), patch: z.string().trim().max(100).default('') }),
  /** A Last.fm user's top or loved tracks. Needs a Last.fm API key. */
  z.object({
    kind: z.literal('lastfm'),
    user: z.string().trim().min(1).max(100),
    chart: LastfmChart.default('top'),
    period: LastfmPeriodOption.default('3month'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
]);
export type PlaylistSource = z.infer<typeof PlaylistSource>;
export type PlaylistSourceInput = z.input<typeof PlaylistSource>;
export type PlaylistSourceKind = PlaylistSource['kind'];

/**
 * What a sync wants from the library. `none` only matches; `tracks` monitors each matched
 * track's album with only the listed tracks monitored (when the album was not monitored
 * before); `albums` monitors the whole album.
 */
export const PlaylistWant = z.enum(['none', 'tracks', 'albums']);
export type PlaylistWant = z.infer<typeof PlaylistWant>;

/** A push target: a configured media server (`server:<id>`) or the Navidrome account in the settings (`navidrome`). */
export const PlaylistTarget = z.string().regex(/^(server:[A-Za-z0-9._-]{1,64}|navidrome)$/);
export type PlaylistTarget = z.infer<typeof PlaylistTarget>;

// ---------------------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------------------

export const PlaylistSyncStatus = z.enum(['never', 'running', 'ok', 'partial', 'failed']);
export type PlaylistSyncStatus = z.infer<typeof PlaylistSyncStatus>;

export const MusicPlaylistCounts = z.object({
  total: z.number().int(),
  /** Matched to a MusicBrainz recording. */
  matched: z.number().int(),
  /** The track has a file in the library. */
  available: z.number().int(),
  /** In the library and monitored, no file yet. */
  wanted: z.number().int(),
});
export type MusicPlaylistCounts = z.infer<typeof MusicPlaylistCounts>;

export const MusicPlaylist = z.object({
  id: z.number().int(),
  name: z.string(),
  source: PlaylistSource,
  want: PlaylistWant,
  /** Add artists that are not in the library yet (monitor option `none`, then only what the playlist wants). */
  addArtists: z.boolean(),
  /** Root folder and profile for added artists; null uses the first root folder / profile. */
  rootFolderPath: z.string().nullable(),
  qualityProfileId: z.number().int().nullable(),
  /** Start an album search for what the sync newly wanted. */
  searchOnWant: z.boolean(),
  writeM3u: z.boolean(),
  targets: z.array(PlaylistTarget),
  /** 0 = manual only. */
  syncIntervalHours: z.number().int().min(0).max(24 * 30),
  enabled: z.boolean(),
  /** The name the source gave the playlist on the last sync. */
  sourceTitle: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: PlaylistSyncStatus,
  lastSyncMessage: z.string().nullable(),
  counts: MusicPlaylistCounts,
  createdAt: z.string(),
});
export type MusicPlaylist = z.infer<typeof MusicPlaylist>;

export const CreateMusicPlaylist = z.object({
  name: z.string().trim().min(1).max(200),
  source: PlaylistSource,
  want: PlaylistWant.default('none'),
  addArtists: z.boolean().default(false),
  rootFolderPath: z.string().trim().min(1).nullable().default(null),
  qualityProfileId: z.number().int().positive().nullable().default(null),
  searchOnWant: z.boolean().default(false),
  writeM3u: z.boolean().default(true),
  targets: z.array(PlaylistTarget).max(20).default([]),
  syncIntervalHours: z.number().int().min(0).max(24 * 30).default(24),
  enabled: z.boolean().default(true),
});
export type CreateMusicPlaylist = z.infer<typeof CreateMusicPlaylist>;
export type CreateMusicPlaylistInput = z.input<typeof CreateMusicPlaylist>;

export const UpdateMusicPlaylist = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  source: PlaylistSource.optional(),
  want: PlaylistWant.optional(),
  addArtists: z.boolean().optional(),
  rootFolderPath: z.string().trim().min(1).nullable().optional(),
  qualityProfileId: z.number().int().positive().nullable().optional(),
  searchOnWant: z.boolean().optional(),
  writeM3u: z.boolean().optional(),
  targets: z.array(PlaylistTarget).max(20).optional(),
  syncIntervalHours: z.number().int().min(0).max(24 * 30).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateMusicPlaylist = z.infer<typeof UpdateMusicPlaylist>;

/**
 * Where one source track stands. `unmatched`: no MusicBrainz recording found. `matched`: a
 * recording, its artist is not in the library. `artistAdded`: the artist was just added and
 * its albums are loading (resolved on the next sync). `notMonitored`: in the library, not
 * wanted. `wanted`: monitored, no file yet. `available`: the track has a file.
 */
export const PlaylistEntryStatus = z.enum(['unmatched', 'matched', 'artistAdded', 'notMonitored', 'wanted', 'available']);
export type PlaylistEntryStatus = z.infer<typeof PlaylistEntryStatus>;

/** How the recording was found. */
export const PlaylistMatchMethod = z.enum(['recording', 'isrc', 'search', 'library']);
export type PlaylistMatchMethod = z.infer<typeof PlaylistMatchMethod>;

export const MusicPlaylistEntry = z.object({
  position: z.number().int(),
  title: z.string(),
  artist: z.string(),
  album: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  isrc: z.string().nullable(),
  status: PlaylistEntryStatus,
  matchMethod: PlaylistMatchMethod.nullable(),
  recordingMbid: z.string().nullable(),
  releaseGroupMbid: z.string().nullable(),
  artistMbid: z.string().nullable(),
  artistId: z.number().int().nullable(),
  albumId: z.number().int().nullable(),
  trackId: z.number().int().nullable(),
  /** The library album/artist names when matched. */
  albumTitle: z.string().nullable(),
  artistName: z.string().nullable(),
});
export type MusicPlaylistEntry = z.infer<typeof MusicPlaylistEntry>;

/** POST /music/playlist/{id}/sync: the sync runs as a job; poll the playlist for its result. */
export const MusicPlaylistSyncStarted = z.object({ jobId: z.number().int().nullable(), status: PlaylistSyncStatus });
export type MusicPlaylistSyncStarted = z.infer<typeof MusicPlaylistSyncStarted>;

/** POST /music/playlist/preview: read the source without matching or saving anything. */
export const MusicPlaylistPreviewRequest = z.object({ source: PlaylistSource });
export type MusicPlaylistPreviewRequest = z.infer<typeof MusicPlaylistPreviewRequest>;

export const MusicPlaylistPreview = z.object({
  title: z.string(),
  description: z.string().nullable(),
  owner: z.string().nullable(),
  trackCount: z.number().int(),
  /** The first 100 tracks as the source lists them. */
  tracks: z.array(z.object({ title: z.string(), artist: z.string(), album: z.string().nullable(), durationMs: z.number().int().nullable() })),
});
export type MusicPlaylistPreview = z.infer<typeof MusicPlaylistPreview>;

// ---------------------------------------------------------------------------------------
// Settings section `musicPlaylists`
// ---------------------------------------------------------------------------------------

export const SimilarArtistSource = z.enum(['listenbrainz', 'lastfm', 'both']);
export type SimilarArtistSource = z.infer<typeof SimilarArtistSource>;

export const MusicPlaylistsSettings = z.object({
  /** A Spotify app (developer dashboard) for reading playlists; both empty turns Spotify sources off. */
  spotifyClientId: z.string().trim().default(''),
  spotifyClientSecret: z.string().default(''),
  /** Last.fm API key: Last.fm sources and the Last.fm half of similar artists. */
  lastfmApiKey: z.string().default(''),
  /** Folder the .m3u8 files are written to; empty writes them into the first music root folder. */
  m3uFolder: z.string().trim().default(''),
  /** Track paths in the .m3u8: relative to the file's folder (portable) or absolute. */
  m3uPaths: z.enum(['relative', 'absolute']).default('relative'),
  /** Optional Navidrome (or any Subsonic API server) account for the `navidrome` target. */
  navidromeUrl: z.string().trim().default(''),
  navidromeUser: z.string().trim().default(''),
  navidromePassword: z.string().default(''),
  /** Where similar artists come from; `both` merges ListenBrainz and Last.fm. */
  similarSource: SimilarArtistSource.default('both'),
  /** Hard cap on MusicBrainz searches per sync (tracks without a recording id or ISRC). */
  maxSearchesPerSync: z.number().int().min(0).max(1000).default(200),
});
export type MusicPlaylistsSettings = z.infer<typeof MusicPlaylistsSettings>;

/** GET /settings/musicplaylists: secrets are SECRET_MASK when stored, '' otherwise. */
export const MusicPlaylistsSettingsResponse = MusicPlaylistsSettings;
export type MusicPlaylistsSettingsResponse = MusicPlaylistsSettings;

/** PUT /settings/musicplaylists: a secret that is SECRET_MASK or omitted keeps the stored one, '' clears it. */
export const MusicPlaylistsSettingsUpdate = MusicPlaylistsSettings.partial();
export type MusicPlaylistsSettingsUpdate = z.infer<typeof MusicPlaylistsSettingsUpdate>;

const PLAYLIST_SECRETS = ['spotifyClientSecret', 'lastfmApiKey', 'navidromePassword'] as const;

export function maskMusicPlaylistsSettings(value: MusicPlaylistsSettings): MusicPlaylistsSettingsResponse {
  const out = { ...value };
  for (const key of PLAYLIST_SECRETS) out[key] = value[key] ? SECRET_MASK : '';
  return out;
}

export function applyMusicPlaylistsUpdate(current: MusicPlaylistsSettings, update: MusicPlaylistsSettingsUpdate): MusicPlaylistsSettings {
  const defined: Record<string, unknown> = Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined));
  for (const key of PLAYLIST_SECRETS) {
    const v = update[key];
    defined[key] = v === undefined || v === SECRET_MASK ? current[key] : v.trim();
  }
  return MusicPlaylistsSettings.parse({ ...current, ...defined });
}

// ---------------------------------------------------------------------------------------
// Similar artists
// ---------------------------------------------------------------------------------------

export const SimilarArtist = z.object({
  mbid: z.string(),
  name: z.string(),
  /** 0-1, higher is closer. */
  score: z.number(),
  /** Which service listed it (`both` when both did). */
  source: SimilarArtistSource,
  /** Library artist id when the artist is in the library. */
  artistId: z.number().int().nullable(),
});
export type SimilarArtist = z.infer<typeof SimilarArtist>;

export const SimilarArtistsResponse = z.object({ items: z.array(SimilarArtist) });
export type SimilarArtistsResponse = z.infer<typeof SimilarArtistsResponse>;
