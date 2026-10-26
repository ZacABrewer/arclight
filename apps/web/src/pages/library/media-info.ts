import type { MediaInfo } from '@arclight/shared';
import { t } from '../../i18n/index.js';

// Badges for a media file row from its ffprobe media info: video codec, resolution, dynamic
// range (HDR only), bit depth, primary audio with channels, extra audio track count.

export interface MediaBadge {
  kind: 'video' | 'resolution' | 'hdr' | 'depth' | 'audio' | 'tracks';
  label: string;
}

/** 6 → "5.1", 8 → "7.1", 2 → "2.0". */
export function channelLabel(channels: number | null | undefined): string | null {
  if (channels == null || !Number.isFinite(channels) || channels <= 0) return null;
  const n = Math.round(channels);
  return n > 2 ? `${n - 1}.1` : `${n}.0`;
}

/** "2160p" from the frame size (or a "1920x1080" resolution string). */
export function resolutionLabel(info: Pick<MediaInfo, 'height' | 'width' | 'resolution'>): string | null {
  let h = info.height ?? null;
  let w = info.width ?? null;
  if ((h == null || w == null) && info.resolution) {
    const m = /^(\d+)\s*x\s*(\d+)$/i.exec(info.resolution.trim());
    if (m) {
      w ??= Number(m[1]);
      h ??= Number(m[2]);
    }
  }
  if (h == null && w == null) return null;
  // Width first catches cropped scope films (3840x1600 is still 2160p).
  if ((w ?? 0) >= 3200 || (h ?? 0) >= 2000) return '2160p';
  if ((w ?? 0) >= 1800 || (h ?? 0) >= 1000) return '1080p';
  if ((w ?? 0) >= 1200 || (h ?? 0) >= 700) return '720p';
  if ((h ?? 0) >= 560) return '576p';
  return '480p';
}

/** Dynamic range badge text; null for SDR or unknown. Adds the Dolby Vision profile when known. */
export function dynamicRangeLabel(info: Pick<MediaInfo, 'videoDynamicRange' | 'videoDynamicRangeType' | 'doviProfile'>): string | null {
  const raw = (info.videoDynamicRangeType ?? info.videoDynamicRange ?? '').trim();
  if (!raw || raw.toUpperCase() === 'SDR') return null;
  const label = raw.replace('HDR10Plus', 'HDR10+');
  return info.doviProfile != null && label.startsWith('DV') ? label.replace(/^DV/, `DV P${info.doviProfile}`) : label;
}

export function mediaBadges(info: MediaInfo | null | undefined): MediaBadge[] {
  if (!info) return [];
  const out: MediaBadge[] = [];
  const video = info.videoCodec ?? info.videoFormat?.toUpperCase();
  if (video) out.push({ kind: 'video', label: video });
  const res = resolutionLabel(info);
  if (res) out.push({ kind: 'resolution', label: res });
  const hdr = dynamicRangeLabel(info);
  if (hdr) out.push({ kind: 'hdr', label: hdr });
  if (info.videoBitDepth != null && info.videoBitDepth > 8) out.push({ kind: 'depth', label: `${info.videoBitDepth}-bit` });
  const audio = info.audioCodec ?? info.audioFormat?.toUpperCase();
  const ch = channelLabel(info.audioChannels);
  if (audio || ch) out.push({ kind: 'audio', label: [audio, ch].filter(Boolean).join(' ') });
  const tracks = info.audioStreamCount ?? info.audioStreams?.length ?? 0;
  if (tracks > 1) out.push({ kind: 'tracks', label: t('library.mediaInfo.valueAudio', { value: tracks - 1 }) });
  return out;
}

/** Plain-text summary for the row tooltip. */
export function mediaInfoSummary(info: MediaInfo | null | undefined): string {
  if (!info) return t('library.mediaInfo.notAnalyzedYet');
  const parts = mediaBadges(info).map((b) => b.label);
  const langs = info.audioLanguages?.filter(Boolean) ?? [];
  if (langs.length) parts.push(`audio ${langs.join(', ')}`);
  if (info.subtitles?.length) parts.push(`subs ${info.subtitles.join(', ')}`);
  return parts.join(' · ') || t('library.mediaInfo.noStreamsFound');
}
