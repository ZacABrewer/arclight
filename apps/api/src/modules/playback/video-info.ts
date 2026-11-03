import { extname } from 'node:path';
import type {
  MediaInfo,
  PlayableChapter,
  TranscodeHwaccel,
  VideoAudioTrack,
  VideoDeviceProfile,
  VideoDynamicRange,
  VideoInfo,
  VideoPlayMethod,
  VideoQuality,
  VideoReason,
  VideoSegment,
  VideoSubtitleTrack,
} from '@arclight/shared';
import { hwInputArgs, presetArgs, videoEncoder } from '../transcode/ffmpeg.js';
import { fileInput } from '../transcode/input-protocols.js';

// The pure half of video playback: media info -> VideoInfo, version labels and badges, segments
// from chapter names, the direct/remux/transcode decision and the ffmpeg argv of a live stream.
// Everything here is deterministic so the unit tests can drive it without files.

/** What media_files and subtitle_files give us about one file. */
export interface VideoFileFacts {
  id: number;
  path: string;
  sizeBytes: number;
  versionTag: string | null;
  edition?: string | null | undefined;
  mediaInfo: MediaInfo | null;
}

/** An external subtitle file (subtitle_files with a path). */
export interface ExternalSubtitle {
  id: number;
  path: string;
  language: string;
  forced: boolean;
  hi: boolean;
  codec: string | null;
}

const CONTAINER_BY_EXT: Record<string, string> = {
  '.mkv': 'mkv',
  '.mk3d': 'mkv',
  '.mp4': 'mp4',
  '.m4v': 'mp4',
  '.webm': 'webm',
  '.mov': 'mov',
  '.avi': 'avi',
  '.ts': 'ts',
  '.m2ts': 'ts',
  '.mts': 'ts',
  '.wmv': 'wmv',
  '.mpg': 'mpeg',
  '.mpeg': 'mpeg',
  '.flv': 'flv',
  '.ogv': 'ogg',
};

const MIME_BY_CONTAINER: Record<string, string> = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  wmv: 'video/x-ms-wmv',
  mpeg: 'video/mpeg',
  flv: 'video/x-flv',
  ogg: 'video/ogg',
};

/** Short container name from the extension, else the probe's format name. */
export function videoContainerOf(path: string, probed: string | null | undefined): string {
  const byExt = CONTAINER_BY_EXT[extname(path).toLowerCase()];
  if (byExt) return byExt;
  const p = (probed ?? '').toLowerCase();
  if (p === 'matroska') return 'mkv';
  if (p === 'mpegts') return 'ts';
  return p || 'unknown';
}

export function videoMimeOf(container: string): string {
  return MIME_BY_CONTAINER[container] ?? 'application/octet-stream';
}

/** Probe codec id (h264, hevc ...), falling back to the friendly name of older media info. */
export function videoCodecOf(info: MediaInfo | null): string {
  if (info?.videoFormat) return info.videoFormat.toLowerCase();
  const friendly = (info?.videoCodec ?? '').toLowerCase();
  if (/x265|hevc|h\.?265/.test(friendly)) return 'hevc';
  if (/x264|avc|h\.?264/.test(friendly)) return 'h264';
  if (friendly.includes('av1')) return 'av1';
  if (friendly.includes('vp9')) return 'vp9';
  if (friendly.includes('vp8')) return 'vp8';
  if (/xvid|divx|mpeg-?4/.test(friendly)) return 'mpeg4';
  if (friendly.includes('mpeg2')) return 'mpeg2video';
  if (friendly.includes('vc1') || friendly.includes('vc-1')) return 'vc1';
  return friendly || 'unknown';
}

/** Client spellings of codecs -> probe ids. */
export function normaliseCodec(codec: string): string {
  const c = codec.trim().toLowerCase();
  const map: Record<string, string> = { h265: 'hevc', hvc1: 'hevc', hev1: 'hevc', avc: 'h264', avc1: 'h264', x264: 'h264', x265: 'hevc', 'e-ac3': 'eac3', ec3: 'eac3', 'ac-3': 'ac3', 'dts-hd': 'dts', mp4a: 'aac' };
  return map[c] ?? c;
}

/** The stored dynamic range string ("DV HDR10", "HDR10Plus", "PQ" ...) as the contract enum. */
export function dynamicRangeOf(info: MediaInfo | null): VideoDynamicRange {
  const raw = (info?.videoDynamicRangeType ?? info?.videoDynamicRange ?? '').toUpperCase();
  if (raw.startsWith('DV') || raw.includes('DOLBY')) return 'dv';
  if (raw.includes('HDR10PLUS') || raw.includes('HDR10+')) return 'hdr10plus';
  if (raw.includes('HLG')) return 'hlg';
  if (raw.includes('HDR') || raw === 'PQ') return 'hdr10';
  const transfer = (info?.colorTransfer ?? '').toLowerCase();
  if (transfer === 'smpte2084') return 'hdr10';
  if (transfer === 'arib-std-b67') return 'hlg';
  return 'sdr';
}

/**
 * The range a device sees when it cannot do Dolby Vision: the base layer of a DV file ("DV
 * HDR10" plays as HDR10, "DV SDR" as SDR); profile 5 and unknown bases have none (null).
 */
export function baseRangeOf(info: MediaInfo | null): VideoDynamicRange | null {
  const range = dynamicRangeOf(info);
  if (range !== 'dv') return range;
  const raw = (info?.videoDynamicRangeType ?? info?.videoDynamicRange ?? '').toUpperCase();
  if (raw.includes('HDR10PLUS')) return 'hdr10plus';
  if (raw.includes('HDR10')) return 'hdr10';
  if (raw.includes('HLG')) return 'hlg';
  if (raw.includes('SDR')) return 'sdr';
  return null;
}

/** Subtitle codecs served as WebVTT; the rest (PGS, VobSub, DVB) are pictures. */
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text', 'text', 'tx3g', 'microdvd', 'subviewer', 'mpl2', 'sami', 'stl', 'realtext']);
export const isTextSubtitle = (codec: string) => TEXT_SUBTITLE_CODECS.has(codec.toLowerCase());

const SUBTITLE_CODEC_BY_EXT: Record<string, string> = { '.srt': 'subrip', '.ass': 'ass', '.ssa': 'ssa', '.vtt': 'webvtt', '.sub': 'microdvd', '.smi': 'sami', '.sup': 'hdmv_pgs_subtitle', '.idx': 'dvd_subtitle' };

export function externalSubtitleCodec(sub: Pick<ExternalSubtitle, 'path' | 'codec'>): string {
  return SUBTITLE_CODEC_BY_EXT[extname(sub.path).toLowerCase()] ?? (sub.codec ?? 'subrip').toLowerCase();
}

export function audioTracksOf(info: MediaInfo | null): VideoAudioTrack[] {
  const streams = info?.audioStreams ?? [];
  if (streams.length > 0) {
    const anyDefault = streams.some((s) => s.default);
    return streams.map((s, index) => ({
      index,
      codec: s.codec.toLowerCase(),
      channels: s.channels ?? null,
      language: s.language ?? null,
      title: s.title ?? null,
      default: anyDefault ? s.default === true : index === 0,
    }));
  }
  if (!info?.audioFormat && !info?.audioCodec) return [];
  return [{ index: 0, codec: (info.audioFormat ?? info.audioCodec ?? 'unknown').toLowerCase(), channels: info.audioChannels ? Math.round(info.audioChannels) : null, language: info.audioLanguages?.[0] ?? null, title: null, default: true }];
}

export function subtitleTracksOf(info: MediaInfo | null, external: readonly ExternalSubtitle[]): VideoSubtitleTrack[] {
  const embedded: VideoSubtitleTrack[] = (info?.subtitleStreams ?? []).map((s, i) => ({
    id: `e${i}`,
    source: 'embedded',
    codec: s.codec.toLowerCase(),
    language: s.language ?? null,
    title: s.title ?? null,
    forced: s.forced,
    hearingImpaired: s.hearingImpaired,
    default: s.default === true,
    text: isTextSubtitle(s.codec),
  }));
  const files: VideoSubtitleTrack[] = external.map((x) => {
    const codec = externalSubtitleCodec(x);
    return { id: `x${x.id}`, source: 'external', codec, language: x.language || null, title: null, forced: x.forced, hearingImpaired: x.hi, default: false, text: isTextSubtitle(codec) };
  });
  return [...embedded, ...files];
}

export function videoInfoOf(file: VideoFileFacts, external: readonly ExternalSubtitle[] = []): VideoInfo {
  const info = file.mediaInfo;
  const overall = info?.overallBitrate ?? null;
  return {
    mediaFileId: file.id,
    versionTag: file.versionTag,
    container: videoContainerOf(file.path, info?.container),
    videoCodec: videoCodecOf(info),
    videoProfile: info?.videoProfile ?? null,
    bitDepth: info?.videoBitDepth ?? null,
    width: info?.width ?? null,
    height: info?.height ?? null,
    fps: info?.videoFps ?? null,
    dynamicRange: dynamicRangeOf(info),
    sizeBytes: file.sizeBytes,
    bitrateKbps: overall ? Math.round(overall / 1000) : estimatedKbps(file.sizeBytes, info?.durationMs ?? null),
    audioTracks: audioTracksOf(info),
    subtitleTracks: subtitleTracksOf(info, external),
  };
}

function estimatedKbps(sizeBytes: number, durationMs: number | null): number | null {
  if (!durationMs || durationMs <= 0 || sizeBytes <= 0) return null;
  return Math.round((sizeBytes * 8) / durationMs);
}

/** Playing time of a file: probed duration, else runtime seconds, else the catalogue runtime. */
export function durationOf(info: MediaInfo | null, runtimeMinutes: number | null | undefined): number {
  if (info?.durationMs) return info.durationMs;
  if (info?.runtimeSeconds) return info.runtimeSeconds * 1000;
  return (runtimeMinutes ?? 0) * 60_000;
}

// ---- labels and badges ------------------------------------------------------------------

/** Resolution name by height (and width, for scope films that are 3840x1600). */
export function resolutionLabel(width: number | null, height: number | null): string | null {
  const h = height ?? 0;
  const w = width ?? 0;
  if (h >= 1800 || w >= 3400) return '4K';
  if (h >= 1300 || w >= 2400) return '1440p';
  if (h >= 900 || w >= 1700) return '1080p';
  if (h >= 650 || w >= 1200) return '720p';
  if (h >= 520) return '576p';
  if (h > 0) return '480p';
  return null;
}

const RANGE_BADGE: Record<VideoDynamicRange, string | null> = { sdr: null, hdr10: 'HDR', hdr10plus: 'HDR', hlg: 'HDR', dv: 'DV' };

/** '4K', 'HDR', 'DV' (in that order) for a file. */
export function badgesOf(info: Pick<VideoInfo, 'width' | 'height' | 'dynamicRange'> | null): string[] {
  if (!info) return [];
  const out: string[] = [];
  if (resolutionLabel(info.width, info.height) === '4K') out.push('4K');
  const range = RANGE_BADGE[info.dynamicRange];
  if (range) out.push(range);
  return out;
}

/** "4K HDR", "1080p", "720p · Director's Cut". */
export function versionLabel(info: VideoInfo, file: Pick<VideoFileFacts, 'versionTag' | 'edition'>): string {
  const res = resolutionLabel(info.width, info.height);
  const range = info.dynamicRange === 'dv' ? 'DV' : info.dynamicRange === 'sdr' ? null : 'HDR';
  const base = [res, range].filter(Boolean).join(' ');
  const extra = file.edition?.trim() || file.versionTag?.trim() || null;
  // A tag that only repeats the resolution or range adds nothing ("4K" slot holding a 4K file).
  const redundant = extra && base.toLowerCase().split(' ').includes(extra.toLowerCase());
  if (!base) return extra ?? 'Original';
  return extra && !redundant ? `${base} · ${extra}` : base;
}

const AUDIO_NAMES: Record<string, string> = { aac: 'AAC', ac3: 'AC3', eac3: 'EAC3', dts: 'DTS', truehd: 'TrueHD', flac: 'FLAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', pcm_s16le: 'PCM', pcm_s24le: 'PCM' };
const VIDEO_NAMES: Record<string, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', vc1: 'VC-1' };

function channelText(channels: number | null): string {
  if (!channels) return '';
  return channels >= 6 ? ` ${channels - 1}.1` : channels === 2 ? ' 2.0' : channels === 1 ? ' 1.0' : ` ${channels}.0`;
}

/** "HEVC 10-bit · EAC3 5.1 · 2160p" for a details page. */
export function versionDescription(info: VideoInfo): string | null {
  const parts: string[] = [];
  if (info.videoCodec !== 'unknown') parts.push(`${VIDEO_NAMES[info.videoCodec] ?? info.videoCodec.toUpperCase()}${info.bitDepth && info.bitDepth > 8 ? ` ${info.bitDepth}-bit` : ''}`);
  const audio = info.audioTracks.find((a) => a.default) ?? info.audioTracks[0];
  if (audio) parts.push(`${AUDIO_NAMES[audio.codec] ?? audio.codec.toUpperCase()}${channelText(audio.channels)}`);
  if (info.height) parts.push(`${info.height}p`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Versions best first: higher resolution, then HDR/DV over SDR, then larger. */
export function compareVersions(a: VideoInfo, b: VideoInfo): number {
  const px = (v: VideoInfo) => (v.width ?? 0) * (v.height ?? 0);
  const hdr = (v: VideoInfo) => (v.dynamicRange === 'sdr' ? 0 : 1);
  return px(b) - px(a) || hdr(b) - hdr(a) || b.sizeBytes - a.sizeBytes || a.mediaFileId - b.mediaFileId;
}

// ---- chapters and segments ------------------------------------------------------------------

interface ProbeChapter {
  start_time?: string | number;
  end_time?: string | number;
  tags?: Record<string, string>;
}

/** `ffprobe -show_chapters -print_format json` output -> chapters (sorted, durations filled in). */
export function parseProbeChapters(json: string, totalMs: number): PlayableChapter[] {
  let data: { chapters?: ProbeChapter[] };
  try {
    data = JSON.parse(json) as { chapters?: ProbeChapter[] };
  } catch {
    return [];
  }
  const list = (data.chapters ?? [])
    .map((c, i) => {
      const start = Math.max(0, Math.round(Number(c.start_time) * 1000));
      const end = Math.round(Number(c.end_time) * 1000);
      const title = (c.tags?.['title'] ?? c.tags?.['TITLE'] ?? '').trim() || `Chapter ${i + 1}`;
      return { title, startMs: Number.isFinite(start) ? start : 0, endMs: Number.isFinite(end) ? end : NaN };
    })
    .sort((a, b) => a.startMs - b.startMs);
  return list.map((c, i) => {
    const next = list[i + 1]?.startMs ?? (totalMs > 0 ? totalMs : c.endMs);
    const end = Number.isFinite(c.endMs) && c.endMs > c.startMs ? c.endMs : next;
    return { title: c.title, startMs: c.startMs, durationMs: Math.max(0, (Number.isFinite(end) ? end : c.startMs) - c.startMs) };
  });
}

const SEGMENT_PATTERNS: Array<[VideoSegment['type'], RegExp]> = [
  ['recap', /\b(recap|previously)\b/i],
  ['intro', /\b(intro|opening|op|title sequence|opening credits|theme)\b/i],
  ['credits', /\b(credits|end credits|ending|outro|ed|closing)\b/i],
];

/** Intro/credits/recap ranges from chapter titles ("Intro", "Opening Credits", "End Credits" ...). */
export function segmentsFromChapters(chapters: readonly PlayableChapter[]): VideoSegment[] {
  const out: VideoSegment[] = [];
  for (const c of chapters) {
    if (c.durationMs <= 0) continue;
    // "Opening credits" is the intro, not the credits.
    const hit = SEGMENT_PATTERNS.find(([, re]) => re.test(c.title));
    if (!hit) continue;
    const type = /opening credits/i.test(c.title) ? 'intro' : hit[0];
    const last = out.at(-1);
    // Neighbouring chapters of the same kind ("Credits", "Credits (cont.)") merge into one range.
    if (last && last.type === type && last.endMs === c.startMs) last.endMs = c.startMs + c.durationMs;
    else out.push({ type, startMs: c.startMs, endMs: c.startMs + c.durationMs });
  }
  return out;
}

// ---- the decision -----------------------------------------------------------------------------

/** Height a quality choice allows (auto/original: the device's limit). */
export function qualityHeight(quality: VideoQuality, maxHeight: number): number {
  const by: Record<VideoQuality, number> = { auto: maxHeight, original: maxHeight, '1080p': 1080, '720p': 720, '480p': 480 };
  return Math.min(by[quality], maxHeight);
}

/** Bitrate a live transcode aims for at a height (H.264; HEVC gets 70 %). */
export function defaultVideoKbps(height: number): number {
  if (height >= 1800) return 25_000;
  if (height >= 1300) return 14_000;
  if (height >= 900) return 8_000;
  if (height >= 650) return 4_000;
  return 1_800;
}

export interface VideoDecisionInput {
  info: VideoInfo;
  /** Base layer range of a DV file (baseRangeOf); null: none. */
  baseRange: VideoDynamicRange | null;
  profile: VideoDeviceProfile;
  audioTrack: number;
  subtitle: VideoSubtitleTrack | null;
  quality: VideoQuality;
  /** The user's/remote cap in kbps (decide()); 0: none. */
  userCapKbps: number;
}

export interface VideoPlan {
  method: VideoPlayMethod;
  reasons: VideoReason[];
  /** Transcode: the output height; else null. */
  height: number | null;
  /** Transcode: the video bitrate in kbps; else null. */
  videoKbps: number | null;
  /** Transcode: the encoder codec. */
  videoCodec: 'h264' | 'hevc' | null;
  /** Remux/transcode: copy the audio track as it is (else AAC). */
  copyAudio: boolean;
  /** Channels of the AAC output (2 or 6). */
  audioChannels: number;
  /** Tone-map HDR to SDR (transcode only; the output is always 8-bit SDR). */
  tonemap: boolean;
  /** The subtitle id burned into the picture. */
  burn: string | null;
}

/** Audio codecs ffmpeg writes into fragmented MP4 as they are. */
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac']);
/** Video codecs that remux into MP4. */
const MP4_VIDEO = new Set(['h264', 'hevc', 'av1', 'vp9']);

/** The bitrate cap that applies: the device's and the user's, the stricter one (0: none). */
export function effectiveCap(profile: Pick<VideoDeviceProfile, 'maxBitrateKbps'>, userCapKbps: number): number {
  const device = profile.maxBitrateKbps ?? 0;
  if (device > 0 && userCapKbps > 0) return Math.min(device, userCapKbps);
  return device > 0 ? device : userCapKbps;
}

function rangeSupported(range: VideoDynamicRange, hdr: readonly string[]): boolean {
  if (range === 'sdr') return true;
  if (range === 'hdr10plus') return hdr.includes('hdr10');
  return hdr.includes(range);
}

/**
 * Direct play when the device takes the file as it is; remux (video copied into fragmented MP4,
 * audio copied or made AAC) when only the container or the audio is the problem; transcode for
 * anything about the picture (codec, 10-bit, HDR, size, bitrate, a burned-in subtitle).
 */
export function decideVideo(input: VideoDecisionInput): VideoPlan {
  const { info, profile } = input;
  const reasons = new Set<VideoReason>();
  const containers = profile.containers.map(normaliseCodec);
  const vcodecs = profile.videoCodecs.map(normaliseCodec);
  const acodecs = profile.audioCodecs.map(normaliseCodec);
  const audio = info.audioTracks.find((a) => a.index === input.audioTrack) ?? info.audioTracks.find((a) => a.default) ?? info.audioTracks[0] ?? null;

  // Picture
  const tenBit = (info.bitDepth ?? 8) > 8;
  if (!vcodecs.includes(info.videoCodec)) reasons.add('video-codec');
  else if (tenBit && info.videoCodec === 'hevc' && !profile.hevc10bit) reasons.add('video-profile');
  else if (tenBit && info.videoCodec === 'h264') reasons.add('video-profile');
  const hdrOk = rangeSupported(info.dynamicRange, profile.hdr) || (info.dynamicRange === 'dv' && input.baseRange !== null && rangeSupported(input.baseRange, profile.hdr));
  if (!hdrOk) reasons.add('hdr');
  const height = info.height ?? 0;
  const allowed = qualityHeight(input.quality, profile.maxHeight);
  if (height > profile.maxHeight + 8) reasons.add('resolution');
  else if (height > allowed + 8) reasons.add('quality');
  const cap = effectiveCap(profile, input.userCapKbps);
  if (cap > 0 && (info.bitrateKbps ?? 0) > cap) reasons.add('bitrate');
  if (input.subtitle && !input.subtitle.text) reasons.add('burn-subtitle');
  // A video codec that cannot go into MP4 (MPEG-2, VC-1 ...) is re-encoded even when listed.
  const pictureOk = reasons.size === 0;

  // Container and audio
  if (!containers.includes(info.container)) reasons.add('container');
  if (audio) {
    if (!acodecs.includes(audio.codec)) reasons.add('audio-codec');
    else if ((audio.channels ?? 2) > profile.maxAudioChannels) reasons.add('audio-channels');
  }

  const order = (list: Iterable<VideoReason>) => [...list].sort((a, b) => VIDEO_REASON_ORDER.indexOf(a) - VIDEO_REASON_ORDER.indexOf(b));
  // A non-default audio track in a file the device would direct play: still direct (the
  // player picks the track itself); the session reports which one.
  const audioOk = !reasons.has('audio-codec') && !reasons.has('audio-channels');
  const copyAudio = audio !== null && audioOk && MP4_AUDIO.has(audio.codec);
  const audioChannels = profile.maxAudioChannels >= 6 && (audio?.channels ?? 2) >= 6 ? 6 : 2;
  if (pictureOk && !reasons.has('container') && audioOk) {
    return { method: 'direct', reasons: [], height: null, videoKbps: null, videoCodec: null, copyAudio: true, audioChannels, tonemap: false, burn: null };
  }
  if (pictureOk && MP4_VIDEO.has(info.videoCodec)) {
    return { method: 'remux', reasons: order(reasons), height: null, videoKbps: null, videoCodec: null, copyAudio, audioChannels, tonemap: false, burn: null };
  }
  if (pictureOk) reasons.add('video-codec');
  const outHeight = Math.min(height > 0 ? height : allowed, allowed);
  const useHevc = vcodecs.includes('hevc') && outHeight > 1080;
  const audioKbps = audioChannels === 6 ? 384 : 192;
  let kbps = defaultVideoKbps(outHeight);
  if (useHevc) kbps = Math.round(kbps * 0.7);
  // Never aim above the source (a low-bitrate file re-encoded for its codec stays small).
  if (info.bitrateKbps && info.bitrateKbps > 0) kbps = Math.min(kbps, Math.max(800, info.bitrateKbps));
  if (cap > 0) kbps = Math.max(300, Math.min(kbps, cap - audioKbps));
  return {
    method: 'transcode',
    reasons: order(reasons),
    height: outHeight,
    videoKbps: kbps,
    videoCodec: useHevc ? 'hevc' : 'h264',
    copyAudio,
    audioChannels,
    // The live pipeline writes 8-bit SDR, so any HDR source is tone-mapped.
    tonemap: info.dynamicRange !== 'sdr',
    burn: input.subtitle && !input.subtitle.text ? input.subtitle.id : null,
  };
}

const VIDEO_REASON_ORDER: readonly VideoReason[] = ['container', 'video-codec', 'video-profile', 'audio-codec', 'audio-channels', 'hdr', 'resolution', 'bitrate', 'burn-subtitle', 'quality'];

// ---- ffmpeg argv --------------------------------------------------------------------------

export interface LiveVideoSpec {
  method: 'remux' | 'transcode';
  /** Audio ordinal; null: no audio track. */
  audioTrack: number | null;
  /** Source codec and channels of that track. */
  audioCodec: string | null;
  audioChannelsIn: number | null;
  copyAudio: boolean;
  audioChannels: number;
  startMs: number;
  // transcode only
  hwaccel?: TranscodeHwaccel;
  videoCodec?: 'h264' | 'hevc';
  height?: number | null;
  sourceHeight?: number | null;
  videoKbps?: number;
  tonemap?: boolean;
  /** Software tone-mapping filters are available (zscale). */
  zscale?: boolean;
  fps?: number | null;
  /** Burn an embedded image subtitle (ordinal) or an external file (path). */
  burn?: { ordinal: number } | { path: string } | null;
  /** The copied video stream is HEVC (tag it hvc1 for Apple players). */
  sourceVideoCodec?: string;
}

const FRAGMENTED_MP4 = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
/** Remux: copied AC-3/E-AC-3/DTS has no frame size until the first packet, so the moov waits for it. */
const FRAGMENTED_MP4_COPY = ['-movflags', 'frag_keyframe+empty_moov+delay_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];

/** Software HDR -> SDR (BT.709) through zscale + tonemap (Hable). */
export const TONEMAP_ZSCALE = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

function audioArgs(spec: LiveVideoSpec): string[] {
  if (spec.audioTrack === null) return ['-an'];
  if (spec.copyAudio) return ['-c:a', 'copy'];
  const ch = spec.audioChannels;
  return ['-c:a', 'aac', '-ac', String(ch), '-b:a', ch >= 6 ? '384k' : '192k'];
}

/** The argv (without the binary) of a live remux/transcode to fragmented MP4 on stdout. */
export function buildVideoStreamArgs(input: string, spec: LiveVideoSpec): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  const hw = spec.method === 'transcode' ? (spec.hwaccel ?? 'none') : 'none';
  if (spec.method === 'transcode') args.push(...hwInputArgs(hw));
  const ss = spec.startMs > 0 ? ['-ss', (spec.startMs / 1000).toFixed(3)] : [];
  args.push(...ss, ...fileInput(input));
  const burn = spec.method === 'transcode' ? (spec.burn ?? null) : null;
  if (burn && 'path' in burn) args.push(...ss, ...fileInput(burn.path));
  const audioMap = spec.audioTrack === null ? [] : ['-map', `0:a:${spec.audioTrack}?`];

  if (spec.method === 'remux') {
    args.push('-map', '0:v:0', ...audioMap, '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'copy');
    if (spec.sourceVideoCodec === 'hevc') args.push('-tag:v', 'hvc1');
    args.push(...audioArgs(spec), '-strict', '-2', '-avoid_negative_ts', 'make_zero', ...FRAGMENTED_MP4_COPY);
    return args;
  }

  const codec = spec.videoCodec ?? 'h264';
  const encoder = videoEncoder(codec, hw);
  const filters: string[] = [];
  if (spec.height && spec.sourceHeight && spec.height < spec.sourceHeight) filters.push(`scale=-2:${spec.height}`);
  if (spec.tonemap && spec.zscale) filters.push(TONEMAP_ZSCALE);
  if (hw === 'qsv') filters.push('format=nv12', 'hwupload=extra_hw_frames=64', 'format=qsv');
  else if (hw === 'vaapi') filters.push('format=nv12', 'hwupload');
  else filters.push('format=yuv420p');
  const chain = filters.join(',');
  if (burn) {
    const sub = 'path' in burn ? '[1:s:0]' : `[0:s:${burn.ordinal}]`;
    // The subtitle picture is scaled to the video, laid over it, then the normal chain runs.
    args.push('-filter_complex', `${sub}[0:v:0]scale2ref[sub][base];[base][sub]overlay=eof_action=pass,${chain}[v]`, '-map', '[v]');
  } else {
    args.push('-map', '0:v:0', '-vf', chain);
  }
  args.push(...audioMap, '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');
  const kbps = Math.round(spec.videoKbps ?? defaultVideoKbps(spec.height ?? 1080));
  const gop = String(Math.max(24, Math.round((spec.fps && spec.fps > 0 ? spec.fps : 24) * 3)));
  args.push('-c:v', encoder, ...presetArgs(encoder, 'veryfast'), '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-g', gop);
  if (codec === 'h264' && hw === 'none') args.push('-profile:v', 'high');
  if (codec === 'hevc') args.push('-tag:v', 'hvc1');
  args.push(...audioArgs(spec), '-strict', '-2', ...FRAGMENTED_MP4);
  return args;
}

/** The argv converting one subtitle stream (embedded ordinal, or a whole external file) to WebVTT at `out`. */
export function buildSubtitleArgs(input: string, ordinal: number | null, out: string, charset?: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...(charset ? ['-sub_charenc', charset] : []), ...fileInput(input), '-map', ordinal === null ? '0:s:0' : `0:s:${ordinal}`, '-c:s', 'webvtt', '-f', 'webvtt', out];
}

/** The argv of a 16:9 frame thumbnail at `atMs`, `width` pixels wide, written as JPEG to `out`. */
export function buildThumbnailArgs(input: string, atMs: number, out: string, width = 480): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', (atMs / 1000).toFixed(3), ...fileInput(input), '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-f', 'image2', out];
}
