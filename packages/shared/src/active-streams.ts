import { z } from 'zod';
import { MobilePlatform } from './mobile.js';
import { ItemKey, PlayableKind, VideoReason } from './playback.js';
import { TranscodeHwaccel } from './transcode.js';
import { VideoHlsRungId } from './video-hls.js';

// Activity -> Now playing (0.25): what Arclight's own player is streaming right now. The server
// keeps an in-memory list fed by playback sessions, stream and segment requests and progress
// heartbeats (apps/api/src/modules/playback/active-streams.ts); admins read it with
// GET /api/v1/activity/streams. Signed stream URLs and tokens are never part of it.

/** A playing stream with no heartbeat or segment request for this long is gone. */
export const ACTIVE_STREAM_IDLE_SEC = 90;
/** A paused one (players send no heartbeats while paused) is kept this long after its last report. */
export const ACTIVE_STREAM_PAUSED_IDLE_SEC = 10 * 60;

/** Where it plays: the web player, the Arclight app on a phone or tablet, the app on a TV, or another client (an API key). */
export const ActiveStreamClientKind = z.enum(['web', 'app', 'tv', 'other']);
export type ActiveStreamClientKind = z.infer<typeof ActiveStreamClientKind>;

export const ActiveStreamMethod = z.enum(['direct', 'remux', 'transcode']);
export type ActiveStreamMethod = z.infer<typeof ActiveStreamMethod>;

export const ActiveStream = z.object({
  /** Opaque, stable while the stream lasts. */
  id: z.string(),
  state: z.enum(['playing', 'paused']),
  startedAt: z.string(),
  lastSeenAt: z.string(),
  user: z.object({ id: z.number().int(), username: z.string() }),
  /** The household profile playing (the owner profile too). Null when unknown (a deleted profile). */
  profile: z.object({ id: z.number().int(), name: z.string(), color: z.string(), initial: z.string(), isOwner: z.boolean() }).nullable(),
  item: z.object({
    itemKey: ItemKey,
    kind: PlayableKind,
    /** Movie, episode, track or book title. */
    title: z.string(),
    /** Episodes: the series. */
    seriesTitle: z.string().nullable(),
    seasonNumber: z.number().int().nullable(),
    episodeNumber: z.number().int().nullable(),
    /** Tracks: the artist; audiobooks: the author(s). */
    artist: z.string().nullable(),
    /** Tracks: the album. */
    album: z.string().nullable(),
    /** Audiobooks: the chapter at the position. */
    chapter: z.string().nullable(),
    year: z.number().int().nullable(),
    /** Same-origin image (cookie auth): poster, album cover or book cover. */
    artworkUrl: z.string().nullable(),
  }),
  /** At the time of the answer (extrapolated from the last report while playing). */
  positionMs: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  client: z.object({
    kind: ActiveStreamClientKind,
    /** "Firefox", "Pixel 8", "Living room TV". */
    deviceName: z.string().nullable(),
    platform: MobilePlatform.nullable(),
    appVersion: z.string().nullable(),
  }),
  /** The client address as the server sees it (X-Forwarded-For only from ARCLIGHT_TRUSTED_PROXIES). */
  address: z.object({ ip: z.string(), remote: z.boolean() }),
  playback: z.object({
    /** Null until a stream or session says how it plays. */
    method: ActiveStreamMethod.nullable(),
    delivery: z.enum(['progressive', 'hls']).nullable(),
    /** Jellyfin/Emby: the bytes come from the media server (Settings -> Player -> Playback engine). */
    backend: z.enum(['arclight', 'jellyfin']),
    reasons: z.array(VideoReason),
    /** HLS: the rung being fetched now. */
    rung: z.object({ id: VideoHlsRungId, height: z.number().int(), videoKbps: z.number().int(), codec: z.string() }).nullable(),
    /** Video converted: the encoder in use (none: software). Null for copies and audio. */
    hwaccel: TranscodeHwaccel.nullable(),
    /** HLS transcode: encoder speed (media seconds per second). */
    encodeSpeed: z.number().nullable(),
    /** Audio converted: the format ("opus", "aac", "mp3"); null when played as it is. */
    audioFormat: z.string().nullable(),
    /** Converted audio: the target bitrate. Video: the rung or transcode bitrate. */
    bitrateKbps: z.number().int().nullable(),
  }),
});
export type ActiveStream = z.infer<typeof ActiveStream>;

/** GET /api/v1/activity/streams (admins): newest first. */
export const ActiveStreamsResponse = z.object({
  streams: z.array(ActiveStream),
  idleSec: z.number().int(),
  pausedIdleSec: z.number().int(),
});
export type ActiveStreamsResponse = z.infer<typeof ActiveStreamsResponse>;
