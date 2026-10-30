import type { MediaInfo, TranscodeAction, TranscodeContainer, TranscodeHwaccel, TranscodeOptions } from '@arclight/shared';

// The pure ffmpeg command builder. Given the source, the temp output path, a rule's action and
// options and the file's media info, it returns the argv (without the binary). Stream indexes
// are relative to their type (`0:a:1` is the second audio track), which is the order
// media-analysis records `audioStreams` / `subtitleStreams` in.

export class TranscodeBuildError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED' | 'NO_MEDIA_INFO',
    message: string,
  ) {
    super(message);
    this.name = 'TranscodeBuildError';
  }
}

export interface BuildSpec {
  action: TranscodeAction;
  options: TranscodeOptions;
}

/** Render node used for VAAPI (pass `/dev/dri` through to the container). */
export const VAAPI_DEVICE = '/dev/dri/renderD128';

type EncodedCodec = 'h264' | 'hevc' | 'av1';

const ENCODERS: Record<TranscodeHwaccel, Partial<Record<EncodedCodec, string>>> = {
  none: { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1' },
  vaapi: { h264: 'h264_vaapi', hevc: 'hevc_vaapi', av1: 'av1_vaapi' },
  qsv: { h264: 'h264_qsv', hevc: 'hevc_qsv', av1: 'av1_qsv' },
  nvenc: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: 'av1_nvenc' },
  videotoolbox: { h264: 'h264_videotoolbox', hevc: 'hevc_videotoolbox' },
};

/** ffmpeg encoder name for a codec on a backend; throws when the backend has none. */
export function videoEncoder(codec: EncodedCodec, hwaccel: TranscodeHwaccel): string {
  const enc = ENCODERS[hwaccel][codec];
  if (!enc) throw new TranscodeBuildError('UNSUPPORTED', `${hwaccel} has no ${codec} encoder`);
  return enc;
}

/** Validates options that can never produce a command (used when saving a rule). */
export function validateOptions(action: TranscodeAction, options: TranscodeOptions): void {
  if (action === 'transcode' && options.videoCodec !== 'copy') videoEncoder(options.videoCodec, options.hwaccel);
}

// ---- quality / preset mapping -------------------------------------------------------------

/** `crf` (x264 scale, lower is better) -> the encoder's own quality switch. */
export function qualityArgs(encoder: string, crf: number | undefined): string[] {
  if (crf === undefined) return [];
  if (encoder.endsWith('_vaapi')) return ['-qp', String(crf)];
  if (encoder.endsWith('_qsv')) return ['-global_quality', String(crf)];
  if (encoder.endsWith('_nvenc')) return ['-rc', 'vbr', '-cq', String(crf), '-b:v', '0'];
  // VideoToolbox: -q:v 1-100, higher is better.
  if (encoder.endsWith('_videotoolbox')) return ['-q:v', String(Math.min(100, Math.max(1, 100 - crf * 2)))];
  return ['-crf', String(crf)];
}

const SVT_PRESETS: Record<string, string> = {
  ultrafast: '12',
  superfast: '11',
  veryfast: '10',
  faster: '9',
  fast: '8',
  medium: '6',
  slow: '4',
  slower: '3',
  veryslow: '2',
  placebo: '1',
};

const NVENC_PRESETS: Record<string, string> = {
  ultrafast: 'p1',
  superfast: 'p1',
  veryfast: 'p2',
  faster: 'p3',
  fast: 'p3',
  medium: 'p4',
  slow: 'p5',
  slower: 'p6',
  veryslow: 'p7',
  placebo: 'p7',
};

const QSV_PRESETS: Record<string, string> = { ultrafast: 'veryfast', superfast: 'veryfast', placebo: 'veryslow' };

/** x264-style or encoder-native preset -> the encoder's `-preset` (VAAPI/VideoToolbox: none). */
export function presetArgs(encoder: string, preset: string | undefined): string[] {
  if (!preset) return [];
  if (encoder.endsWith('_vaapi') || encoder.endsWith('_videotoolbox')) return [];
  if (encoder === 'libsvtav1') return ['-preset', /^\d+$/.test(preset) ? preset : (SVT_PRESETS[preset] ?? '8')];
  if (encoder.endsWith('_nvenc')) return ['-preset', /^p[1-7]$/.test(preset) ? preset : (NVENC_PRESETS[preset] ?? 'p4')];
  if (encoder.endsWith('_qsv')) return ['-preset', QSV_PRESETS[preset] ?? preset];
  return ['-preset', preset];
}

// ---- languages ----------------------------------------------------------------------------

/** ISO 639-1 / 639-2 (B and T) spellings of common languages, first entry canonical. */
const LANGUAGE_GROUPS: string[][] = [
  ['eng', 'en'],
  ['ger', 'deu', 'de'],
  ['fre', 'fra', 'fr'],
  ['spa', 'es'],
  ['ita', 'it'],
  ['jpn', 'ja'],
  ['kor', 'ko'],
  ['chi', 'zho', 'zh'],
  ['por', 'pt'],
  ['rus', 'ru'],
  ['dut', 'nld', 'nl'],
  ['swe', 'sv'],
  ['nor', 'nob', 'no', 'nb'],
  ['dan', 'da'],
  ['fin', 'fi'],
  ['pol', 'pl'],
  ['hin', 'hi'],
  ['ara', 'ar'],
  ['tur', 'tr'],
  ['cze', 'ces', 'cs'],
  ['hun', 'hu'],
  ['gre', 'ell', 'el'],
  ['heb', 'he'],
  ['tha', 'th'],
  ['vie', 'vi'],
  ['ukr', 'uk'],
  ['rum', 'ron', 'ro'],
];
const CANONICAL = new Map<string, string>(LANGUAGE_GROUPS.flatMap((g) => g.map((code) => [code, g[0]!] as const)));

export function canonicalLanguage(code: string): string {
  const c = code.trim().toLowerCase();
  return CANONICAL.get(c) ?? c;
}

/** Empty `keep` keeps everything; untagged (`und`/missing) tracks are always kept. */
export function languageKept(language: string | null | undefined, keep: readonly string[]): boolean {
  if (keep.length === 0) return true;
  if (!language || language.toLowerCase() === 'und') return true;
  const lang = canonicalLanguage(language);
  return keep.some((k) => canonicalLanguage(k) === lang);
}

// ---- stream plan --------------------------------------------------------------------------

/** Subtitle codecs that convert to mp4's `mov_text`; image subtitles (PGS, VobSub) cannot. */
const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'tx3g']);

export interface StreamPlan {
  /** Kept audio indexes, or `all` when the file's tracks are unknown / no filter applies. */
  audio: number[] | 'all';
  /** Kept subtitle indexes, `all`, or `none`. */
  subtitles: number[] | 'all' | 'none';
}

export function planStreams(options: TranscodeOptions, container: TranscodeContainer, info: MediaInfo | null): StreamPlan {
  const keep = options.keepLanguages;
  const audioStreams = info?.audioStreams ?? null;
  let audio: StreamPlan['audio'] = 'all';
  if (audioStreams && audioStreams.length > 0 && keep.length > 0) {
    const kept = audioStreams.flatMap((s, i) => (languageKept(s.language, keep) ? [i] : []));
    // Never write a silent file: when no track matches, keep them all.
    audio = kept.length > 0 ? kept : 'all';
  }

  let subtitles: StreamPlan['subtitles'];
  const subs = info?.subtitleStreams ?? null;
  if (options.dropSubtitles) subtitles = 'none';
  else if (container === 'mp4') {
    // mp4 holds text subtitles only (as mov_text); without media info we cannot tell which.
    subtitles = subs ? subs.flatMap((s, i) => (TEXT_SUBTITLES.has(s.codec.toLowerCase()) && languageKept(s.language, keep) ? [i] : [])) : 'none';
    if (subtitles.length === 0) subtitles = 'none';
  } else if (subs && keep.length > 0) {
    subtitles = subs.flatMap((s, i) => (languageKept(s.language, keep) ? [i] : []));
    if (subtitles.length === 0) subtitles = 'none';
  } else subtitles = 'all';
  return { audio, subtitles };
}

// ---- builder ------------------------------------------------------------------------------

function isTenBit(info: MediaInfo | null): boolean {
  return (info?.videoBitDepth ?? 8) > 8;
}

function hwInputArgs(hwaccel: TranscodeHwaccel): string[] {
  switch (hwaccel) {
    case 'vaapi':
      return ['-vaapi_device', VAAPI_DEVICE];
    case 'qsv':
      return ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'];
    case 'nvenc':
      return ['-hwaccel', 'cuda'];
    case 'videotoolbox':
      return ['-hwaccel', 'videotoolbox'];
    case 'none':
      return [];
  }
}

function videoArgs(options: TranscodeOptions, codec: EncodedCodec, info: MediaInfo | null): string[] {
  const encoder = videoEncoder(codec, options.hwaccel);
  const out = ['-c:v', encoder];
  // h264 encoders take 8-bit input; HEVC/AV1 keep 10-bit sources at 10 bits.
  const tenBitOut = isTenBit(info) && codec !== 'h264';
  if (options.hwaccel === 'vaapi') out.push('-vf', `format=${tenBitOut ? 'p010' : 'nv12'},hwupload`);
  else if (options.hwaccel === 'qsv') out.push('-vf', `format=${tenBitOut ? 'p010' : 'nv12'},hwupload=extra_hw_frames=64,format=qsv`);
  else if (codec === 'h264' && isTenBit(info)) out.push('-pix_fmt', 'yuv420p');
  out.push(...qualityArgs(encoder, options.crf), ...presetArgs(encoder, options.preset));
  return out;
}

/** x264/x265 preset names (the software encoders reject the NVENC/QSV-native ones). */
const SOFTWARE_PRESETS = new Set(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'placebo']);

/**
 * The same options on software encoders (hardware fallback). A backend-native preset (`p5`)
 * would make libx264 fail, so only presets the software encoders take are kept.
 */
export function softwareOptions(options: TranscodeOptions): TranscodeOptions {
  const { preset, ...rest } = options;
  const keep = preset !== undefined && (SOFTWARE_PRESETS.has(preset) || (options.videoCodec === 'av1' && /^\d+$/.test(preset)));
  return { ...rest, hwaccel: 'none', ...(keep ? { preset } : {}) };
}

/**
 * Capability test for a backend: one 256x256 lavfi frame through the backend's init args and
 * H.264 encoder, built by the same helpers as a job so the test fails where a job would.
 */
export function capabilityTestArgs(hwaccel: TranscodeHwaccel): string[] {
  const options: TranscodeOptions = { container: 'mkv', videoCodec: 'h264', audio: 'copy', keepLanguages: [], dropSubtitles: false, hwaccel };
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    ...hwInputArgs(hwaccel),
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=256x256:rate=1',
    '-frames:v',
    '1',
    ...videoArgs(options, 'h264', null),
    '-an',
    '-f',
    'null',
    '-',
  ];
}

function audioBitrate(codec: 'aac' | 'eac3', channels: number): string {
  if (codec === 'eac3') return channels <= 2 ? '224k' : '640k';
  return `${Math.min(512, channels * 64)}k`;
}

/**
 * The ffmpeg argv for one job. `input`/`output` are paths; `output`'s extension does not
 * matter (the muxer is forced with `-f`).
 */
export function buildFfmpegArgs(input: string, output: string, spec: BuildSpec, info: MediaInfo | null): string[] {
  const { action, options } = spec;
  const container = options.container;
  const encodeVideo = action === 'transcode' && options.videoCodec !== 'copy';
  const encodeAudio = action === 'transcode' && options.audio !== 'copy';
  const plan = planStreams(options, container, info);

  const args = ['-hide_banner', '-nostdin', '-y'];
  if (encodeVideo) args.push(...hwInputArgs(options.hwaccel));
  args.push('-i', input);

  // ---- maps
  args.push('-map', '0:v:0');
  if (plan.audio === 'all') args.push('-map', '0:a?');
  else for (const i of plan.audio) args.push('-map', `0:a:${i}`);

  let compat: { source: number; outIndex: number } | null = null;
  if (action === 'addAudioTrack') {
    const count = info?.audioStreams?.length ?? info?.audioStreamCount ?? 0;
    if (!info) throw new TranscodeBuildError('NO_MEDIA_INFO', 'addAudioTrack needs media info (analyze the file first)');
    if (count === 0) throw new TranscodeBuildError('UNSUPPORTED', 'the file has no audio track to convert');
    const kept = plan.audio === 'all' ? Array.from({ length: count }, (_, i) => i) : plan.audio;
    compat = { source: kept[0]!, outIndex: kept.length };
    args.push('-map', `0:a:${compat.source}`);
  }

  if (plan.subtitles === 'all') args.push('-map', '0:s?');
  else if (plan.subtitles !== 'none') for (const i of plan.subtitles) args.push('-map', `0:s:${i}`);
  if (container === 'mkv') args.push('-map', '0:t?');
  args.push('-map_metadata', '0', '-map_chapters', '0');

  // ---- video
  if (encodeVideo) args.push(...videoArgs(options, options.videoCodec as EncodedCodec, info));
  else args.push('-c:v', 'copy');
  const hevcOut = encodeVideo ? options.videoCodec === 'hevc' : info?.videoFormat?.toLowerCase() === 'hevc';
  if (container === 'mp4' && hevcOut) args.push('-tag:v', 'hvc1');

  // ---- audio
  if (encodeAudio) {
    const codec = options.audio as 'aac' | 'eac3';
    args.push('-c:a', codec);
    if (options.channels !== undefined) args.push('-ac', String(options.channels), '-b:a', audioBitrate(codec, options.channels));
  } else args.push('-c:a', 'copy');
  if (compat) {
    const codec = options.audio === 'copy' ? 'aac' : options.audio;
    const channels = options.channels ?? 2;
    const n = compat.outIndex;
    const label = `${channels === 2 ? 'Stereo' : channels === 1 ? 'Mono' : `${channels}ch`} (${codec.toUpperCase()})`;
    args.push(
      `-c:a:${n}`,
      codec,
      `-ac:a:${n}`,
      String(channels),
      `-b:a:${n}`,
      audioBitrate(codec, channels),
      `-metadata:s:a:${n}`,
      `title=${label}`,
      `-disposition:a:${n}`,
      '0',
    );
  }

  // ---- subtitles / attachments
  if (plan.subtitles === 'none') args.push('-sn');
  else args.push('-c:s', container === 'mp4' ? 'mov_text' : 'copy');
  if (container === 'mkv') args.push('-c:t', 'copy');

  // ---- container
  if (container === 'mp4') args.push('-movflags', '+faststart', '-f', 'mp4');
  else args.push('-f', 'matroska');
  args.push('-max_muxing_queue_size', '1024', '-progress', 'pipe:1', '-nostats', output);
  return args;
}

/** argv -> one display string (quotes arguments with spaces or shell characters). */
export function formatCommand(binary: string, args: readonly string[]): string {
  return [binary, ...args].map((a) => (a === '' || /[\s"'$`\\|&;<>()*?!]/.test(a) ? `"${a.replace(/(["\\$`])/g, '\\$1')}"` : a)).join(' ');
}

/** File extension for a container. */
export function containerExtension(container: TranscodeContainer): string {
  return container === 'mp4' ? '.mp4' : '.mkv';
}
