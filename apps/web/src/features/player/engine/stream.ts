import type { PlayablePart, StreamFormat } from '@arclight/shared';

// Picking how to fetch one file: the original bytes when the browser can decode them (range
// requests, instant seeks), otherwise a live server transcode to Opus (AAC on Safari, which
// has no Opus in <audio> everywhere). Transcodes have no ranges, so seeking re-requests with
// ?startMs=.

/** Codec names as the library reports them → the RFC 6381 string canPlayType understands. */
const CODEC_STRINGS: Record<string, string> = {
  flac: 'flac',
  alac: 'alac',
  aac: 'mp4a.40.2',
  'he-aac': 'mp4a.40.5',
  opus: 'opus',
  vorbis: 'vorbis',
  mp3: 'mp3',
};

/** The MIME type with a codecs parameter when it narrows the answer (ALAC vs AAC in .m4a). */
export function mimeWithCodec(part: Pick<PlayablePart, 'mimeType' | 'codec'>): string {
  const codec = part.codec ? CODEC_STRINGS[part.codec.toLowerCase()] : undefined;
  if (!codec || part.mimeType.includes('codecs=')) return part.mimeType;
  // audio/mpeg and audio/flac name their only codec; a parameter only confuses some browsers.
  if (part.mimeType === 'audio/mpeg' || part.mimeType === 'audio/flac' || part.mimeType === 'audio/wav') return part.mimeType;
  return `${part.mimeType}; codecs="${codec}"`;
}

export interface CanPlay {
  canPlayType(type: string): string;
}

/** The browser says it can (probably or maybe) decode this part. */
export function canPlayPart(el: CanPlay, part: Pick<PlayablePart, 'mimeType' | 'codec'>): boolean {
  try {
    return el.canPlayType(mimeWithCodec(part)) !== '';
  } catch {
    return false;
  }
}

export function isSafari(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /safari/i.test(userAgent) && !/chrome|chromium|crios|fxios|android|edg\//i.test(userAgent);
}

/** Opus everywhere it plays; AAC on Safari and wherever Opus is missing. */
export function preferredTranscode(el: CanPlay, userAgent?: string): 'opus' | 'aac' {
  if (isSafari(userAgent)) return 'aac';
  try {
    if (el.canPlayType('audio/ogg; codecs="opus"') !== '' || el.canPlayType('audio/webm; codecs="opus"') !== '') return 'opus';
  } catch {
    // Fall through.
  }
  return 'aac';
}

export const DEFAULT_TRANSCODE_KBPS: Record<'opus' | 'aac', number> = { opus: 160, aac: 256 };

export interface StreamChoice {
  format: StreamFormat;
  /** Live transcode (no ranges, seek by re-request). */
  transcoded: boolean;
  bitrateKbps: number | null;
}

export interface StreamPolicy {
  /** The browser can decode this part as it is. */
  playable: boolean;
  transcodeTo: 'opus' | 'aac';
  /** Effective cap for this connection (PlayerCapabilities.maxBitrateKbps); 0: none. */
  maxBitrateKbps: number;
  /** Ignore `playable` (the direct stream already failed). */
  forceTranscode?: boolean | undefined;
}

export function chooseStream(part: Pick<PlayablePart, 'bitrateKbps'>, policy: StreamPolicy): StreamChoice {
  const overCap = policy.maxBitrateKbps > 0 && part.bitrateKbps !== null && part.bitrateKbps > policy.maxBitrateKbps;
  if (policy.playable && !overCap && !policy.forceTranscode) return { format: 'original', transcoded: false, bitrateKbps: part.bitrateKbps };
  const preferred = DEFAULT_TRANSCODE_KBPS[policy.transcodeTo];
  const bitrate = policy.maxBitrateKbps > 0 ? Math.max(32, Math.min(preferred, policy.maxBitrateKbps)) : preferred;
  return { format: policy.transcodeTo, transcoded: true, bitrateKbps: bitrate };
}

// Readers report long codec names ("MPEG 1 Layer 3", "mp4a.40.2"); show the short ones.
const CODEC_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/flac/i, 'FLAC'],
  [/alac|apple lossless/i, 'ALAC'],
  [/mpeg.*layer\s*3|mp3|^mpeg$/i, 'MP3'],
  [/aac|mp4a/i, 'AAC'],
  [/vorbis/i, 'VORBIS'],
  [/opus/i, 'OPUS'],
  [/^pcm|wav/i, 'WAV'],
  [/aiff/i, 'AIFF'],
];

/** "FLAC", "MP3 320", "FLAC 24/96": the codec of the original file for the format badge. */
export function codecLabel(part: Pick<PlayablePart, 'codec' | 'container' | 'mimeType' | 'bitrateKbps' | 'bitDepth' | 'sampleRateHz'>): string {
  const raw = part.codec ?? part.container ?? part.mimeType.replace(/^audio\//, '');
  const name = CODEC_NAMES.find(([re]) => re.test(raw))?.[1] ?? raw.toUpperCase();
  const lossless = /^(FLAC|ALAC|WAV|PCM)/.test(name);
  if (lossless && part.bitDepth && part.sampleRateHz && (part.bitDepth > 16 || part.sampleRateHz > 48_000)) {
    return `${name} ${part.bitDepth}/${Math.round(part.sampleRateHz / 1000)}`;
  }
  if (!lossless && part.bitrateKbps) return `${name} ${part.bitrateKbps}`;
  return name;
}
