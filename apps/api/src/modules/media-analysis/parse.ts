import type { MediaAudioStream, MediaInfo, MediaSubtitleStream } from '@arclight/shared';

// ffprobe JSON (`-print_format json -show_format -show_streams`, optionally plus the first
// video frame's side data from `-show_frames`) -> MediaInfo. Pure; no process spawning here.

export class FfprobeParseError extends Error {
  readonly code = 'PARSE';
  constructor(message: string) {
    super(message);
    this.name = 'FfprobeParseError';
  }
}

interface SideData {
  side_data_type?: string;
  dv_profile?: number;
  dv_bl_signal_compatibility_id?: number;
}

/** The subset of an ffprobe stream object this parser reads. */
export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  field_order?: string;
  color_transfer?: string;
  color_primaries?: string;
  bit_rate?: string;
  channels?: number;
  channel_layout?: string;
  duration?: string;
  tags?: Record<string, string | undefined>;
  disposition?: Record<string, number | undefined>;
  side_data_list?: SideData[];
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string | undefined> };
}

export interface FfprobeFrames {
  frames?: Array<{ side_data_list?: SideData[] }>;
}

function toJson<T>(input: string | T): T {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as T;
  } catch {
    throw new FfprobeParseError('ffprobe output is not valid JSON');
  }
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '' || v === 'N/A') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const posInt = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? Math.round(n) : null;
};

/** Case-insensitive tag lookup (Matroska writes `BPS`, `BPS-eng`, `DURATION`, `language` ...). */
function tag(tags: Record<string, string | undefined> | undefined, ...names: string[]): string | undefined {
  if (!tags) return undefined;
  for (const name of names) {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(tags)) if (k.toLowerCase() === lower && v) return v;
  }
  return undefined;
}

/** `00:42:10.123000000` -> seconds. */
function hmsSeconds(text: string | undefined): number | null {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text?.trim() ?? '');
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function language(tags: FfprobeStream['tags']): string | null {
  const l = tag(tags, 'language')?.trim().toLowerCase();
  return l && l !== 'und' && l !== 'unk' ? l : null;
}

function flag(s: FfprobeStream, name: string): boolean {
  return (s.disposition?.[name] ?? 0) === 1;
}

function streamBitrate(s: FfprobeStream): number | null {
  return posInt(s.bit_rate) ?? posInt(tag(s.tags, 'BPS', 'BPS-eng'));
}

function frameRate(text: string | undefined): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(text ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  const d = Number(m[2]);
  if (!n || !d) return null;
  return Math.round((n / d) * 1000) / 1000;
}

function bitDepth(s: FfprobeStream): number | null {
  const raw = posInt(s.bits_per_raw_sample);
  if (raw) return raw;
  const fmt = s.pix_fmt ?? '';
  if (!fmt) return null;
  const m = /p(\d{2})(?:le|be)?$/.exec(fmt);
  if (m) return Number(m[1]);
  return /^(yuv|yuvj|nv12|gray|rgb|bgr)/.test(fmt) ? 8 : null;
}

function container(formatName: string | undefined): string | null {
  const first = formatName?.split(',')[0]?.trim();
  if (!first) return null;
  if (first === 'mov') return 'mp4';
  return first;
}

// ---------------------------------------------------------------------------------------
// Friendly names
// ---------------------------------------------------------------------------------------

export function friendlyVideoCodec(codec: string | undefined, tagString?: string): string | null {
  const c = (codec ?? '').toLowerCase();
  const t = (tagString ?? '').toLowerCase();
  if (!c) return null;
  const map: Record<string, string> = {
    h264: 'AVC',
    hevc: 'HEVC',
    av1: 'AV1',
    vvc: 'VVC',
    mpeg2video: 'MPEG2',
    mpeg1video: 'MPEG',
    vc1: 'VC1',
    vp8: 'VP8',
    vp9: 'VP9',
  };
  if (map[c]) return map[c];
  if (c === 'mpeg4' || c.startsWith('msmpeg4')) {
    if (t === 'xvid') return 'XviD';
    if (t === 'divx' || t === 'dx50' || t === 'div3') return 'DivX';
    return 'MPEG4';
  }
  if (/^wmv[1-3]$/.test(c)) return 'WMV';
  return codec ?? null;
}

export function friendlyAudioCodec(codec: string | undefined, profile?: string | null): string | null {
  const c = (codec ?? '').toLowerCase();
  const p = (profile ?? '').toLowerCase();
  if (!c) return null;
  const atmos = p.includes('atmos');
  switch (c) {
    case 'truehd':
      return atmos ? 'TrueHD Atmos' : 'TrueHD';
    case 'eac3':
      return atmos ? 'EAC3 Atmos' : 'EAC3';
    case 'ac3':
      return 'AC3';
    case 'flac':
      return 'FLAC';
    case 'opus':
      return 'Opus';
    case 'vorbis':
      return 'Vorbis';
    case 'mp3':
      return 'MP3';
    case 'mp2':
      return 'MP2';
    case 'aac':
      return p.includes('he-aac') ? 'HE-AAC' : 'AAC';
    case 'dts':
      if (p.includes('dts:x') || p.includes('dts-x')) return 'DTS-X';
      if (p.includes('ma')) return 'DTS-HD MA';
      if (p.includes('hra') || p.includes('high resolution')) return 'DTS-HD HRA';
      if (p.includes('express')) return 'DTS Express';
      if (p.includes('es')) return 'DTS-ES';
      return 'DTS';
    default:
      if (c.startsWith('pcm_')) return 'PCM';
      if (c.startsWith('wma')) return 'WMA';
      return codec ?? null;
  }
}

/** Decimal channel count the way media tools show it: 6 -> 5.1, 8 -> 7.1. */
export function decimalChannels(channels: number | null, layout?: string): number | null {
  const fromLayout = /^(\d+)\.(\d)/.exec(layout ?? '');
  if (fromLayout) return Number(`${fromLayout[1]}.${fromLayout[2]}`);
  if (!channels) return null;
  if (channels >= 6) return Number(`${channels - 1}.1`);
  return channels;
}

function channelPositions(channels: number | null, layout?: string): string | null {
  const l = (layout ?? '').toLowerCase();
  const m = /^(\d+\.\d)/.exec(l);
  if (m?.[1]) return m[1];
  if (l === 'stereo' || l === 'downmix') return '2.0';
  if (l === 'mono') return '1.0';
  const d = decimalChannels(channels);
  return d === null ? null : d.toFixed(1);
}

// ---------------------------------------------------------------------------------------
// Dynamic range
// ---------------------------------------------------------------------------------------

const isDovi = (sd: SideData) => /dovi|dolby vision conf/i.test(sd.side_data_type ?? '');
const isHdr10Plus = (sd: SideData) => /2094-40|hdr10\+/i.test(sd.side_data_type ?? '');
const isMastering = (sd: SideData) => /mastering display/i.test(sd.side_data_type ?? '');

export interface DynamicRange {
  type: string;
  doviProfile: number | null;
}

export function detectDynamicRange(video: FfprobeStream, frameSideData: readonly SideData[] = []): DynamicRange {
  const side = [...(video.side_data_list ?? []), ...frameSideData];
  const transfer = (video.color_transfer ?? '').toLowerCase();
  const primaries = (video.color_primaries ?? '').toLowerCase();
  const pq = transfer === 'smpte2084';
  const hlg = transfer === 'arib-std-b67';
  const hdr10plus = side.some(isHdr10Plus);
  const dovi = side.find(isDovi);

  if (dovi) {
    const profile = num(dovi.dv_profile);
    const compat = num(dovi.dv_bl_signal_compatibility_id);
    let base: string | null;
    if (compat === 1 || compat === 6) base = hdr10plus ? 'HDR10Plus' : 'HDR10';
    else if (compat === 2) base = 'SDR';
    else if (compat === 4) base = 'HLG';
    else if (compat === 0) base = null;
    else base = pq ? (hdr10plus ? 'HDR10Plus' : 'HDR10') : hlg ? 'HLG' : null;
    return { type: base ? `DV ${base}` : 'DV', doviProfile: profile };
  }
  if (pq && hdr10plus) return { type: 'HDR10Plus', doviProfile: null };
  if (pq) return { type: primaries === 'bt2020' || side.some(isMastering) ? 'HDR10' : 'PQ', doviProfile: null };
  if (hlg) return { type: 'HLG', doviProfile: null };
  return { type: 'SDR', doviProfile: null };
}

/** True when the HDR10+ check (first-frame side data) can change the verdict. */
export function needsFrameProbe(output: FfprobeOutput | string): boolean {
  const data = toJson<FfprobeOutput>(output);
  const video = primaryVideo(data.streams ?? []);
  return (video?.color_transfer ?? '').toLowerCase() === 'smpte2084';
}

function primaryVideo(streams: readonly FfprobeStream[]): FfprobeStream | undefined {
  return streams.find((s) => s.codec_type === 'video' && !flag(s, 'attached_pic'));
}

// ---------------------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------------------

/**
 * Parse ffprobe output into MediaInfo. `frames` is the optional `-show_frames` output for the
 * first video frame (HDR10+ / Dolby Vision RPU side data only appear there).
 */
export function parseFfprobeOutput(output: FfprobeOutput | string, frames?: FfprobeFrames | string | null): MediaInfo {
  const data = toJson<FfprobeOutput>(output);
  if (!data || typeof data !== 'object' || (!data.streams && !data.format)) {
    throw new FfprobeParseError('ffprobe output has neither streams nor format');
  }
  const frameData = frames ? toJson<FfprobeFrames>(frames) : null;
  const frameSide = (frameData?.frames ?? []).flatMap((f) => f.side_data_list ?? []);
  const streams = data.streams ?? [];
  const video = primaryVideo(streams);
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');

  const durationSeconds =
    num(data.format?.duration) ?? num(video?.duration) ?? hmsSeconds(tag(video?.tags, 'DURATION', 'DURATION-eng')) ?? null;

  const info: MediaInfo = {
    container: container(data.format?.format_name),
    durationMs: durationSeconds !== null ? Math.round(durationSeconds * 1000) : null,
    runtimeSeconds: durationSeconds !== null ? Math.round(durationSeconds) : null,
    overallBitrate: posInt(data.format?.bit_rate),
  };

  if (video) {
    const range = detectDynamicRange(video, frameSide);
    const width = posInt(video.width);
    const height = posInt(video.height);
    const tagString = (video.codec_tag_string ?? '').toLowerCase();
    Object.assign(info, {
      videoFormat: video.codec_name ?? null,
      videoCodec: friendlyVideoCodec(video.codec_name, tagString),
      videoCodecId: /^[a-z0-9]{4}$/.test(tagString) ? tagString : null,
      videoProfile: video.profile ?? null,
      videoBitDepth: bitDepth(video),
      videoBitrate: streamBitrate(video),
      videoFps: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate),
      width,
      height,
      resolution: width && height ? `${width}x${height}` : null,
      videoDynamicRange: range.type,
      videoDynamicRangeType: range.type,
      doviProfile: range.doviProfile,
      colorPrimaries: video.color_primaries ?? null,
      colorTransfer: video.color_transfer ?? null,
      scanType: scanType(video.field_order),
    } satisfies Partial<MediaInfo>);
  }

  const audioStreams: MediaAudioStream[] = audio.map((s) => {
    const a: MediaAudioStream = {
      codec: s.codec_name ?? 'unknown',
      profile: s.profile ?? null,
      channels: posInt(s.channels),
      channelLayout: s.channel_layout ?? null,
      language: language(s.tags),
      bitrate: streamBitrate(s),
      title: tag(s.tags, 'title') ?? null,
      default: flag(s, 'default'),
    };
    return a;
  });
  const primary = audio.find((s) => flag(s, 'default')) ?? audio[0];
  if (primary) {
    const channels = posInt(primary.channels);
    Object.assign(info, {
      audioFormat: primary.codec_name ?? null,
      audioCodec: friendlyAudioCodec(primary.codec_name, primary.profile),
      audioProfile: primary.profile ?? null,
      audioChannels: decimalChannels(channels, primary.channel_layout),
      audioChannelPositions: channelPositions(channels, primary.channel_layout),
      audioBitrate: streamBitrate(primary),
    } satisfies Partial<MediaInfo>);
  }
  info.audioStreamCount = audio.length;
  info.audioStreams = audioStreams;
  info.audioLanguages = unique(audioStreams.map((a) => a.language));

  const subtitleStreams: MediaSubtitleStream[] = subs.map((s) => {
    const title = tag(s.tags, 'title') ?? null;
    return {
      codec: s.codec_name ?? 'unknown',
      language: language(s.tags),
      forced: flag(s, 'forced') || /\bforced\b/i.test(title ?? ''),
      hearingImpaired: flag(s, 'hearing_impaired') || /\b(sdh|cc)\b|hearing/i.test(title ?? ''),
      default: flag(s, 'default'),
      title,
    };
  });
  info.subtitleStreams = subtitleStreams;
  info.subtitles = unique(subtitleStreams.map((s) => s.language));
  return info;
}

function scanType(fieldOrder: string | undefined): 'Progressive' | 'Interlaced' | null {
  const f = (fieldOrder ?? '').toLowerCase();
  if (f === 'progressive') return 'Progressive';
  if (f === 'tt' || f === 'bb' || f === 'tb' || f === 'bt') return 'Interlaced';
  return null;
}

function unique(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) if (v && !out.includes(v)) out.push(v);
  return out;
}
