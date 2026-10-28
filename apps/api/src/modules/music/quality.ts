import { MUSIC_QUALITIES, QUALITIES, type AudioCodec, type QualityDefinition, type QualityModel } from '@arclight/shared';

// The music quality of a file on disk, from what the tag reader measured (codec, bitrate, bit
// depth). Release-name parsing (`parseMusicRelease`, Wave 2) is not needed for files that can be
// read. Unknown codecs give the `Unknown` quality.

const CODEC_PATTERNS: ReadonlyArray<readonly [RegExp, AudioCodec]> = [
  [/flac/i, 'FLAC'],
  [/alac|apple lossless/i, 'ALAC'],
  [/mpeg.*layer\s*3|^mp3$|mp3/i, 'MP3'],
  [/aac|mp4a/i, 'AAC'],
  [/vorbis/i, 'Vorbis'],
  [/opus/i, 'Opus'],
  [/^pcm|wav/i, 'WAV'],
  [/aiff/i, 'AIFF'],
  [/monkey|^ape$/i, 'APE'],
  [/wavpack/i, 'WavPack'],
  [/dsd|dsf|dff/i, 'DSD'],
];

/** Normalises a reader's codec name (`MPEG 1 Layer 3`, `flac`, `mp4a.40.2` ...). */
export function audioCodecOf(codec: string | null | undefined, container?: string | null): AudioCodec {
  for (const value of [codec, container]) {
    if (!value) continue;
    for (const [re, name] of CODEC_PATTERNS) if (re.test(value)) return name;
  }
  return 'Unknown';
}

function fits(q: QualityDefinition, codec: AudioCodec, kbps: number | null, bitDepth: number | null): boolean {
  const a = q.audio;
  if (!a || !a.codecs.includes(codec)) return false;
  if (a.vbr) return false; // a VBR preset cannot be told from a measured bitrate
  if (a.bitDepth !== undefined) {
    const depth = bitDepth ?? 16;
    if (a.bitDepth === 24 ? depth < 24 : depth >= 24) return false;
  }
  if (kbps === null) return a.minKbps === undefined;
  if (a.minKbps !== undefined && kbps < a.minKbps) return false;
  if (a.maxKbps !== undefined && kbps > a.maxKbps) return false;
  return true;
}

export interface MeasuredAudio {
  codec: string | null;
  container?: string | null;
  bitrateKbps: number | null;
  bitDepth: number | null;
}

/** The best fitting music quality, or `Unknown`. */
export function musicQualityFor(measured: MeasuredAudio): QualityModel {
  const codec = audioCodecOf(measured.codec, measured.container);
  // Measured lossy bitrates sit a little under the nominal one (320 → 318): round up 2%.
  const kbps = measured.bitrateKbps !== null && measured.bitrateKbps > 0 ? Math.round(measured.bitrateKbps * 1.02) : null;
  const found =
    codec === 'Unknown'
      ? undefined
      : MUSIC_QUALITIES.filter((q) => fits(q, codec, kbps, measured.bitDepth)).sort((a, b) => b.weight - a.weight)[0];
  const q = found ?? QUALITIES.Unknown;
  return { quality: { ...q, mediaTypes: [...q.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };
}
