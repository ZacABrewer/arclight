import { QUALITIES, type AudioCodec, type AudioVbrPreset, type QualityDefinition, type Revision } from '@arclight/shared';
import { parseRevision } from './quality.js';

// Audio quality detection for music releases and files.
//
// 1. The codec comes from the name ("FLAC", "MP3", "AAC", "Opus" ...). Words that are also
//    ordinary English ("Opus", "Ape") only count in capitals or inside brackets, so "Magnum
//    Opus" stays a title. A bitrate or VBR preset with no codec means MP3; a bit depth, a
//    sample rate or "Lossless" with no codec means FLAC.
// 2. Bitrate ("320", "320kbps", "MP3-320"), VBR preset (V0/V1/V2/APS/APX), bit depth
//    ("24bit", "24-96") and sample rate ("96kHz", "24/192") are read independently.
// 3. The file extension fills in the codec when the name has none.
// 4. `audioQualityFor` maps the facts to one music quality id (see the rules there).

export interface ParsedAudioQuality {
  codec: AudioCodec;
  bitrateKbps: number | null;
  vbrPreset: AudioVbrPreset | null;
  bitDepth: number | null;
  sampleRateHz: number | null;
  /** The music quality these facts map to (a `QUALITIES` entry; `Unknown` when unsure). */
  quality: QualityDefinition;
  revision: Revision;
  /** 'name' when anything came from the title, 'extension' when only the extension told us. */
  detectionSource: 'name' | 'extension' | 'unknown';
}

/** Facts about an audio stream, before they are mapped to a quality. */
export interface AudioFacts {
  codec: AudioCodec;
  bitrateKbps: number | null;
  vbrPreset: AudioVbrPreset | null;
  bitDepth: number | null;
  sampleRateHz: number | null;
}

const L = String.raw`(?<![\p{L}\p{N}])`;
const R = String.raw`(?![\p{L}\p{N}])`;
const re = (src: string, flags = 'iu') => new RegExp(src, flags);

const EXTENSION_CODEC: Record<string, AudioCodec> = {
  flac: 'FLAC',
  mp3: 'MP3',
  m4a: 'AAC',
  aac: 'AAC',
  mp4: 'AAC',
  ogg: 'Vorbis',
  oga: 'Vorbis',
  opus: 'Opus',
  wav: 'WAV',
  aif: 'AIFF',
  aiff: 'AIFF',
  ape: 'APE',
  wv: 'WavPack',
  dsf: 'DSD',
  dff: 'DSD',
};

/** Audio file extensions the music parser strips and reads. */
export const AUDIO_EXTENSIONS: ReadonlyArray<string> = Object.keys(EXTENSION_CODEC);

const AUDIO_EXTENSION = re(String.raw`\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff?|ape|wv|dsf|dff|cue|log|torrent|nzb|zip|rar)$`, 'i');

export function stripAudioExtension(name: string): { title: string; extension: string | null } {
  const m = AUDIO_EXTENSION.exec(name);
  if (!m) return { title: name, extension: null };
  return { title: name.slice(0, m.index), extension: m[1]!.toLowerCase() };
}

export function codecFromExtension(extension: string | null): AudioCodec | null {
  return extension ? (EXTENSION_CODEC[extension.toLowerCase()] ?? null) : null;
}

// Codec tokens in priority order: the first kind found anywhere in the name wins, so a
// lossless codec beats an MP3 mentioned alongside it ("FLAC + MP3").
const CODEC_TOKENS: ReadonlyArray<readonly [AudioCodec, RegExp]> = [
  ['DSD', re(String.raw`${L}(?:DSD(?:64|128|256|512)?|DSF|DFF|SACD[-. ]?ISO|ISO[-. ]?SACD)${R}`)],
  ['ALAC', re(String.raw`${L}(?:ALAC|Apple[-. ]Lossless)${R}`)],
  ['FLAC', re(String.raw`${L}FLAC(?:\d{2})?${R}`)],
  ['WavPack', re(String.raw`${L}(?:WavPack|WV)${R}`)],
  ['APE', re(String.raw`${L}(?:APE|Monkey'?s[-. ]Audio)${R}`)],
  ['WAV', re(String.raw`${L}(?:WAV|PCM|LPCM)${R}`)],
  ['AIFF', re(String.raw`${L}AIFF?${R}`)],
  ['Opus', re(String.raw`${L}Opus${R}`)],
  ['Vorbis', re(String.raw`${L}(?:Vorbis|OGG)${R}`)],
  ['AAC', re(String.raw`${L}(?:AAC|M4A|iTunes[-. ]Plus)${R}`)],
  ['MP3', re(String.raw`${L}(?:MP3|LAME)${R}`)],
];

/** Codecs whose names are also words; they need capitals or a bracket around them. */
const WORDY: ReadonlySet<AudioCodec> = new Set(['Opus', 'APE', 'Vorbis', 'WavPack', 'AIFF']);

function bracketed(name: string, index: number): boolean {
  const before = name.slice(0, index);
  const open = Math.max(before.lastIndexOf('['), before.lastIndexOf('('), before.lastIndexOf('{'));
  const close = Math.max(before.lastIndexOf(']'), before.lastIndexOf(')'), before.lastIndexOf('}'));
  return open > close;
}

function findCodec(name: string): AudioCodec | null {
  for (const [codec, pattern] of CODEC_TOKENS) {
    const g = new RegExp(pattern.source, 'giu');
    for (const m of name.matchAll(g)) {
      if (WORDY.has(codec) && m[0] !== m[0].toUpperCase() && !bracketed(name, m.index)) continue;
      // "M4A" says lossless when "Lossless" is written next to it.
      if (codec === 'AAC' && /^m4a$/i.test(m[0]) && /lossless/i.test(name)) return 'ALAC';
      return codec;
    }
  }
  return null;
}

const KBPS = re(String.raw`${L}(\d{2,3})(?:[.,]\d+)?\s?(?:kbps|kbit/?s|kbs|kb/s|kbits|k)${R}`);
const CODEC_THEN_RATE = re(String.raw`${L}(?:MP3|AAC|Opus|Vorbis|OGG|M4A)[-_. ]{0,2}(?:CBR[-_. ]?)?(\d{2,3})(?!\d)(?![-.]\d)`);
const RATE_THEN_CODEC = re(String.raw`${L}(\d{3})[-_. ]?(?:MP3|AAC)${R}`);
const CBR = re(String.raw`${L}CBR[-_. ]?(\d{2,3})${R}`);
/** A lone common bitrate inside brackets or as its own field: "[320]", "-320-". */
const BARE_RATE = /(?:^|[[(\-_ ])(96|112|128|160|192|224|256|320)(?:[\])\-_ ]|$)/;
const VBR = /(?<![A-Za-z0-9])(V[012]|APS|APX)(?![A-Za-z0-9])/;
const VBR_WORD = re(String.raw`${L}(?:MP3[-_. ]?)?(?:VBR[-_. ]?)?(V[012])${R}`);
const BIT_DEPTH = re(String.raw`(?<!\d)(16|24|32)[-_. ]?(?:bits?|b)${R}`);
const DEPTH_RATE_PAIR = re(String.raw`(?<![\d.])(16|24|32)(?:[-_ ]?bits?)?\s?[-/x]\s?(44[.,]1|44|48|88[.,]2|88|96|176[.,]4|176|192|352[.,]8|352|384)(?:\s?k(?:hz)?)?(?![\d])`);
const KHZ = re(String.raw`(?<![\d.])(\d{2,3}(?:[.,]\d)?)[-_ ]?kHz${R}`);
const HI_RES = re(String.raw`${L}Hi[-_. ]?Res${R}`);
const LOSSLESS = re(String.raw`${L}Lossless${R}`);

function khzToHz(text: string): number | null {
  const v = Number(text.replace(',', '.'));
  if (!Number.isFinite(v) || v < 8 || v > 800) return null;
  // Written-short rates: 44 → 44.1, 88 → 88.2, 176 → 176.4, 352 → 352.8.
  const exact: Record<number, number> = { 44: 44100, 88: 88200, 176: 176400, 352: 352800 };
  return exact[v] ?? Math.round(v * 1000);
}

function bitrateFrom(name: string): number | null {
  for (const pattern of [KBPS, CODEC_THEN_RATE, RATE_THEN_CODEC, CBR]) {
    const m = pattern.exec(name);
    if (m) {
      const v = Number(m[1]);
      if (v >= 32 && v <= 512) return v;
    }
  }
  const bare = BARE_RATE.exec(name);
  return bare ? Number(bare[1]) : null;
}

/** Read the audio facts a release or file name states. Fields the name does not state are null. */
export function readAudioFacts(name: string): AudioFacts & { stated: boolean } {
  // Years and dates are never bitrates or depths: "2016-2020", "24.12.2019".
  const text = name.replace(/(?<!\d)(?:19|20)\d{2}(?:[-./](?:19|20)?\d{2}){0,2}(?!\d)/g, ' ');
  let codec = findCodec(text);
  let vbrPreset: AudioVbrPreset | null = null;
  const vbr = VBR.exec(text) ?? VBR_WORD.exec(text);
  if (vbr) vbrPreset = vbr[1]!.toUpperCase() as AudioVbrPreset;

  let bitDepth: number | null = null;
  let sampleRateHz: number | null = null;
  const pair = DEPTH_RATE_PAIR.exec(text);
  if (pair) {
    bitDepth = Number(pair[1]);
    sampleRateHz = khzToHz(pair[2]!);
  }
  const depth = BIT_DEPTH.exec(text);
  if (depth) bitDepth = Number(depth[1]);
  const khz = KHZ.exec(text);
  if (khz) sampleRateHz = khzToHz(khz[1]!) ?? sampleRateHz;

  const lossyCodec = codec === null || codec === 'MP3' || codec === 'AAC' || codec === 'Opus' || codec === 'Vorbis';
  // "24-96" and "96kHz" are depth/rate, not a 96 kbps bitrate.
  const rateText = text.replace(new RegExp(DEPTH_RATE_PAIR.source, 'giu'), ' ').replace(new RegExp(KHZ.source, 'giu'), ' ');
  let bitrateKbps = lossyCodec ? bitrateFrom(rateText) : null;
  if (codec === null && (bitrateKbps !== null || vbrPreset !== null)) codec = 'MP3';
  if (codec !== null && codec !== 'MP3') vbrPreset = null;
  if (codec === null && /(?<![a-z])SACD(?![a-z])/i.test(text)) codec = 'DSD';
  if (codec === null && (bitDepth !== null || sampleRateHz !== null || LOSSLESS.test(text))) codec = 'FLAC';
  if (bitDepth === null && HI_RES.test(text) && (codec === 'FLAC' || codec === 'ALAC')) bitDepth = 24;
  // Lossless releases do not state a meaningful bitrate.
  if (codec !== null && !['MP3', 'AAC', 'Opus', 'Vorbis'].includes(codec)) bitrateKbps = null;

  const stated = codec !== null || bitDepth !== null || sampleRateHz !== null;
  return { codec: codec ?? 'Unknown', bitrateKbps, vbrPreset, bitDepth, sampleRateHz, stated };
}

/**
 * Map audio facts to a music quality:
 * - FLAC / ALAC with 24-bit or a sample rate above 48 kHz → FLAC-24bit / ALAC-24bit, else FLAC / ALAC.
 * - MP3: V0/APX → MP3-VBR-V0; V1/V2/APS → MP3-VBR-V2; otherwise by bitrate: < 160 MP3-Low,
 *   160-223 MP3-192, 224-287 MP3-256, ≥ 288 MP3-320. No bitrate → Unknown.
 * - AAC: < 192 AAC-Low, 192-287 AAC-256, ≥ 288 AAC-320. No bitrate → Unknown.
 * - Vorbis, Opus → their own quality. WAV/AIFF → PCM. APE/WavPack → Lossless-Other. DSD → DSD.
 * - Unknown codec → Unknown.
 */
export function audioQualityFor(facts: Omit<AudioFacts, 'codec'> & { codec: AudioCodec }): QualityDefinition {
  const { codec, bitrateKbps: kbps, vbrPreset, bitDepth, sampleRateHz } = facts;
  const hiRes = (bitDepth !== null && bitDepth >= 24) || (sampleRateHz !== null && sampleRateHz > 48000);
  switch (codec) {
    case 'FLAC':
      return hiRes ? QUALITIES['FLAC-24bit'] : QUALITIES.FLAC;
    case 'ALAC':
      return hiRes ? QUALITIES['ALAC-24bit'] : QUALITIES.ALAC;
    case 'MP3':
      if (vbrPreset === 'V0' || vbrPreset === 'APX') return QUALITIES['MP3-VBR-V0'];
      if (vbrPreset === 'V1' || vbrPreset === 'V2' || vbrPreset === 'APS') return QUALITIES['MP3-VBR-V2'];
      if (kbps === null) return QUALITIES.Unknown;
      if (kbps < 160) return QUALITIES['MP3-Low'];
      if (kbps < 224) return QUALITIES['MP3-192'];
      if (kbps < 288) return QUALITIES['MP3-256'];
      return QUALITIES['MP3-320'];
    case 'AAC':
      if (kbps === null) return QUALITIES.Unknown;
      if (kbps < 192) return QUALITIES['AAC-Low'];
      if (kbps < 288) return QUALITIES['AAC-256'];
      return QUALITIES['AAC-320'];
    case 'Vorbis':
      return QUALITIES.Vorbis;
    case 'Opus':
      return QUALITIES.Opus;
    case 'WAV':
    case 'AIFF':
      return QUALITIES.PCM;
    case 'APE':
    case 'WavPack':
      return QUALITIES['Lossless-Other'];
    case 'DSD':
      return QUALITIES.DSD;
    case 'Unknown':
      return QUALITIES.Unknown;
  }
}

function build(facts: AudioFacts, revision: Revision, detectionSource: ParsedAudioQuality['detectionSource']): ParsedAudioQuality {
  return { ...facts, quality: audioQualityFor(facts), revision, detectionSource };
}

/**
 * Audio quality of a music release or file name. `extension` (without the dot) fills in the
 * codec when the name has none; when the name and the extension disagree on the codec the
 * extension wins, since it describes the actual file.
 */
export function parseAudioQuality(name: string, extension: string | null = null): ParsedAudioQuality {
  const facts = readAudioFacts(name);
  const revision = parseRevision(name);
  const fromExt = codecFromExtension(extension);
  const { stated, ...rest } = facts;
  if (fromExt && fromExt !== rest.codec) {
    // The extension describes the actual file; keep the name's facts only when they agree.
    const keepDepth = fromExt === 'FLAC' || fromExt === 'ALAC' || fromExt === 'WAV' || fromExt === 'AIFF' || fromExt === 'WavPack';
    const lossy = fromExt === 'MP3' || fromExt === 'AAC' || fromExt === 'Opus' || fromExt === 'Vorbis';
    const merged: AudioFacts = {
      codec: rest.codec === 'ALAC' && fromExt === 'AAC' ? 'ALAC' : fromExt,
      bitrateKbps: lossy ? rest.bitrateKbps : null,
      vbrPreset: fromExt === 'MP3' ? rest.vbrPreset : null,
      bitDepth: keepDepth ? rest.bitDepth : null,
      sampleRateHz: rest.sampleRateHz,
    };
    const usedName = merged.bitrateKbps !== null || merged.vbrPreset !== null || merged.bitDepth !== null || merged.codec === 'ALAC';
    return build(merged, revision, usedName ? 'name' : 'extension');
  }
  if (stated) return build(rest, revision, 'name');
  return build(rest, revision, 'unknown');
}

/** Combine what a file name and its folder say: the file wins, the folder fills gaps of the same codec. */
export function mergeAudioQuality(file: ParsedAudioQuality, folder: ParsedAudioQuality): ParsedAudioQuality {
  if (folder.codec === 'Unknown') return file;
  // ".m4a" holds AAC or ALAC; a folder that says ALAC settles it.
  const m4aAlac = file.codec === 'AAC' && folder.codec === 'ALAC' && file.detectionSource === 'extension';
  if (file.codec !== 'Unknown' && file.codec !== folder.codec && !m4aAlac) return file;
  const facts: AudioFacts = {
    codec: file.codec === 'Unknown' || m4aAlac ? folder.codec : file.codec,
    bitrateKbps: file.bitrateKbps ?? folder.bitrateKbps,
    vbrPreset: file.vbrPreset ?? folder.vbrPreset,
    bitDepth: file.bitDepth ?? folder.bitDepth,
    sampleRateHz: file.sampleRateHz ?? folder.sampleRateHz,
  };
  const revision = file.revision.version > 1 || file.revision.isRepack ? file.revision : folder.revision;
  const usedFolder = facts.bitrateKbps !== file.bitrateKbps || facts.vbrPreset !== file.vbrPreset || facts.bitDepth !== file.bitDepth || facts.sampleRateHz !== file.sampleRateHz || file.codec === 'Unknown';
  return build(facts, revision, usedFolder || file.detectionSource === 'name' ? 'name' : file.detectionSource);
}
