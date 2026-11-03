import { audioCodecString, videoRangeTag, type LadderRung } from './ladder.js';
import type { HlsAudioOut } from './pipeline.js';
import type { SegmentPlan } from './plan.js';

// Playlists are written by us from the segment plan, not by ffmpeg: complete and seekable from
// the first request (VOD), whatever the encoder has produced so far. Every URI carries the
// signed query, since a relative URI drops the playlist's own query string.

const withQuery = (uri: string, query: string) => (query ? `${uri}?${query}` : uri);

/** The master playlist: one EXT-X-STREAM-INF per rung, best first (the order is the client's level index). */
export function masterPlaylist(rungs: readonly LadderRung[], audio: HlsAudioOut | null, query: string, fps: number | null): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const r of rungs) {
    const codecs = [r.codecs, ...(audio ? [audioCodecString(audio.codec)] : [])].join(',');
    const attrs = [
      `BANDWIDTH=${Math.round(r.bandwidth)}`,
      `AVERAGE-BANDWIDTH=${Math.round(r.avgBandwidth)}`,
      `CODECS="${codecs}"`,
      ...(r.width > 0 && r.height > 0 ? [`RESOLUTION=${r.width}x${r.height}`] : []),
      ...(fps && fps > 0 ? [`FRAME-RATE=${fps.toFixed(3)}`] : []),
      `VIDEO-RANGE=${videoRangeTag(r.range)}`,
    ];
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`, withQuery(`${r.id}/index.m3u8`, query));
  }
  return lines.join('\n') + '\n';
}

/** A rung's VOD media playlist. */
export function mediaPlaylist(plan: Pick<SegmentPlan, 'durations'>, query: string): string {
  const target = Math.max(1, Math.ceil(Math.max(...plan.durations) - 1e-3));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MAP:URI="${withQuery('init.mp4', query)}"`];
  plan.durations.forEach((d, n) => lines.push(`#EXTINF:${d.toFixed(6)},`, withQuery(`${n}.m4s`, query)));
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}
