import { z } from 'zod';
import { TranscodeHwaccel } from './transcode.js';

// Video delivery over HLS (0.24). Everything that is not direct play can be served as HLS with
// fMP4 (CMAF) segments: a precomputed VOD playlist that is seekable from the first request, with
// segment timestamps in media time (so subtitles need no shifting), segment-on-demand encoding
// and an ABR ladder built from the source, the device and the measured encoder capacity.
// Old clients that do not send `deliveries` keep the progressive (single response) streams.
//
// The fields below extend VideoSessionRequest and VideoSession (playback.ts) additively; all
// request fields are optional so 0.23 clients keep working unchanged.

/** progressive: one ffmpeg response (direct play byte ranges, or the legacy remux/transcode). hls: playlists + segments. */
export const VideoDelivery = z.enum(['progressive', 'hls']);
export type VideoDelivery = z.infer<typeof VideoDelivery>;

/** Ladder rungs, best first in a master playlist: `src` copies the source video, the others are transcodes. */
export const VideoHlsRungId = z.enum(['360', '480', '720', '1080', '2160', 'src']);
export type VideoHlsRungId = z.infer<typeof VideoHlsRungId>;

/** Extra VideoSessionRequest fields. */
export const VideoSessionRequestHlsFields = {
  /** What the client can play; absent = ['progressive']. */
  deliveries: z.array(VideoDelivery).max(2).optional(),
  /** Last measured throughput hint (kbit/s). */
  bandwidthKbps: z.number().int().min(1).max(10_000_000).optional(),
  /** Direct play stalled on this item: do not offer direct play again (fall back to HLS). */
  avoidDirect: z.boolean().optional(),
  /** Stable per device (slot accounting; a new session on the same device replaces the old one). */
  deviceKey: z.string().min(1).max(64).optional(),
};

export const VideoHlsRung = z.object({
  id: VideoHlsRungId,
  height: z.number().int(),
  videoKbps: z.number().int(),
  codec: z.enum(['h264', 'hevc', 'copy']),
  range: z.enum(['sdr', 'hdr10', 'hlg']),
  /** Index of this rung's EXT-X-STREAM-INF in the master playlist (hls.js level / Media3 track). */
  level: z.number().int(),
});
export type VideoHlsRung = z.infer<typeof VideoHlsRung>;

export const VideoHlsInfo = z.object({
  /** Signed master playlist URL. */
  masterUrl: z.string(),
  rungs: z.array(VideoHlsRung),
  /** The rung id the client should start on. */
  startRung: z.string(),
  /** Signed GET → VideoHlsHealth. */
  healthUrl: z.string(),
});
export type VideoHlsInfo = z.infer<typeof VideoHlsInfo>;

/**
 * Extra VideoSession fields. For HLS: seekable true, streamStartMs 0, url = masterUrl, mimeType
 * 'application/vnd.apple.mpegurl'.
 */
export const VideoSessionHlsFields = {
  /** Default 'progressive' for old clients. */
  delivery: VideoDelivery.default('progressive'),
  /** HLS session id (null for progressive). */
  sessionId: z.string().nullable().default(null),
  hls: VideoHlsInfo.optional(),
};

/** GET /playback/video/session/:sessionId/health (also the `X-Arclight-Encode` header on segments). */
export const VideoHlsHealth = z.object({
  /** Encoder speed (media s per wall s, smoothed); null before the warm-up or for no encoder. */
  encodeSpeed: z.number().nullable(),
  /** Seconds encoded ahead of the latest requested segment. */
  aheadSec: z.number(),
  /** The best rung the encoder can sustain; null = no limit known. */
  maxSustainableRung: z.string().nullable(),
  hwaccel: TranscodeHwaccel,
});
export type VideoHlsHealth = z.infer<typeof VideoHlsHealth>;

/** Error code on a segment of a rung the encoder cannot sustain (HTTP 409); clients switch level. */
export const RUNG_UNSUSTAINABLE = 'RUNG_UNSUSTAINABLE';
export const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';
