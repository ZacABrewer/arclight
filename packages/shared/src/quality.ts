import { z } from 'zod';

// The quality vocabulary every part of Arclight speaks: parser output, profile ranking,
// decision engine, UI labels. Names follow the vocabulary users already know from the
// *arr ecosystem so quality profiles translate one-to-one.

export const QualitySource = z.enum([
  'unknown',
  'cam',
  'telesync',
  'telecine',
  'workprint',
  'dvd',
  'television', // broadcast capture, encoded (HDTV)
  'televisionRaw', // broadcast capture, raw transport stream (Raw-HD)
  'web', // WEB-DL
  'webRip',
  'bluray',
  'blurayRaw', // remux / full disc
]);
export type QualitySource = z.infer<typeof QualitySource>;

export const QualityModifier = z.enum(['none', 'regional', 'screener', 'rawhd', 'brdisk', 'remux']);
export type QualityModifier = z.infer<typeof QualityModifier>;

/** Vertical resolution in lines; 0 when unknown/not applicable. */
export const Resolution = z.union([
  z.literal(0),
  z.literal(360),
  z.literal(480),
  z.literal(540),
  z.literal(576),
  z.literal(720),
  z.literal(1080),
  z.literal(2160),
]);
export type Resolution = z.infer<typeof Resolution>;

/**
 * Every media type a quality can apply to. Kept here (not imported from library.ts, which
 * imports this file) so the vocabulary has no circular dependency; it equals `AnyMediaType`.
 */
export const QualityMediaType = z.enum(['series', 'movie', 'music', 'audiobook']);
export type QualityMediaType = z.infer<typeof QualityMediaType>;

/**
 * The family a quality profile belongs to. Video profiles rank video qualities for series and
 * movies; music and audiobook profiles rank audio qualities. Qualities, profiles and the
 * Sonarr/Radarr compat output never mix domains.
 */
export const MediaDomain = z.enum(['video', 'music', 'audiobook']);
export type MediaDomain = z.infer<typeof MediaDomain>;

/** Audio codec vocabulary shared by the audio parser, tag reader and quality descriptors. */
export const AudioCodec = z.enum([
  'FLAC',
  'ALAC',
  'MP3',
  'AAC',
  'Vorbis',
  'Opus',
  'WAV',
  'AIFF',
  'APE',
  'WavPack',
  'DSD',
  'Unknown',
]);
export type AudioCodec = z.infer<typeof AudioCodec>;

/** LAME VBR presets a release name or tag can state. */
export const AudioVbrPreset = z.enum(['V0', 'V1', 'V2', 'APS', 'APX']);
export type AudioVbrPreset = z.infer<typeof AudioVbrPreset>;

/**
 * What makes an audio quality: the codecs it covers, lossless or not, and the bitrate / VBR /
 * bit-depth band. Bitrates are kbps, inclusive. Absent bounds mean "any".
 */
export const AudioQualityDescriptor = z.object({
  codecs: z.array(AudioCodec).min(1),
  lossless: z.boolean(),
  minKbps: z.number().int().min(0).optional(),
  maxKbps: z.number().int().min(0).optional(),
  vbr: AudioVbrPreset.optional(),
  bitDepth: z.union([z.literal(16), z.literal(24)]).optional(),
});
export type AudioQualityDescriptor = z.infer<typeof AudioQualityDescriptor>;

export interface QualityDefinition {
  id: number;
  name: string;
  source: QualitySource;
  resolution: Resolution;
  modifier: QualityModifier;
  /** Default ranking weight: higher is better. Profiles can reorder. Compared within one domain only. */
  weight: number;
  /** Series and/or movies (video), or music, or audiobooks. A quality never spans video and audio. */
  mediaTypes: ReadonlyArray<QualityMediaType>;
  /** Audio qualities only. */
  audio?: AudioQualityDescriptor | undefined;
}

const def = (
  id: number,
  name: string,
  source: QualitySource,
  resolution: Resolution,
  weight: number,
  mediaTypes: ReadonlyArray<'series' | 'movie'> = ['series', 'movie'],
  modifier: QualityModifier = 'none',
): QualityDefinition => ({ id, name, source, resolution, modifier, weight, mediaTypes });

/** An audio quality: no video source or resolution, exactly one audio media type. */
const audio = (
  id: number,
  name: string,
  weight: number,
  mediaType: 'music' | 'audiobook',
  descriptor: AudioQualityDescriptor,
): QualityDefinition => ({
  id,
  name,
  source: 'unknown',
  resolution: 0,
  modifier: 'none',
  weight,
  mediaTypes: [mediaType],
  audio: descriptor,
});
const lossy = (
  codecs: AudioCodec[],
  band: Omit<AudioQualityDescriptor, 'codecs' | 'lossless'> = {},
): AudioQualityDescriptor => ({ codecs, lossless: false, ...band });
const lossless = (codecs: AudioCodec[], bitDepth?: 16 | 24): AudioQualityDescriptor => ({
  codecs,
  lossless: true,
  ...(bitDepth !== undefined && { bitDepth }),
});

export const QUALITIES = {
  Unknown: def(0, 'Unknown', 'unknown', 0, 0),
  // Pre-release / low grade (movies)
  WORKPRINT: def(24, 'WORKPRINT', 'workprint', 0, 1, ['movie']),
  CAM: def(25, 'CAM', 'cam', 0, 2, ['movie']),
  TELESYNC: def(26, 'TELESYNC', 'telesync', 0, 3, ['movie']),
  TELECINE: def(27, 'TELECINE', 'telecine', 0, 4, ['movie']),
  REGIONAL: def(28, 'REGIONAL', 'dvd', 480, 5, ['movie'], 'regional'),
  DVDSCR: def(23, 'DVDSCR', 'dvd', 480, 6, ['movie'], 'screener'),
  // SD
  SDTV: def(1, 'SDTV', 'television', 480, 10),
  DVD: def(2, 'DVD', 'dvd', 480, 11),
  'DVD-R': def(22, 'DVD-R', 'dvd', 480, 12, ['movie'], 'remux'),
  'WEBDL-480p': def(8, 'WEBDL-480p', 'web', 480, 13),
  'WEBRip-480p': def(12, 'WEBRip-480p', 'webRip', 480, 13),
  'Bluray-480p': def(13, 'Bluray-480p', 'bluray', 480, 14),
  'Bluray-576p': def(14, 'Bluray-576p', 'bluray', 576, 15),
  // HD 720
  'HDTV-720p': def(4, 'HDTV-720p', 'television', 720, 20),
  'WEBDL-720p': def(5, 'WEBDL-720p', 'web', 720, 21),
  'WEBRip-720p': def(15, 'WEBRip-720p', 'webRip', 720, 21),
  'Bluray-720p': def(6, 'Bluray-720p', 'bluray', 720, 22),
  // HD 1080
  'HDTV-1080p': def(9, 'HDTV-1080p', 'television', 1080, 30),
  'WEBDL-1080p': def(3, 'WEBDL-1080p', 'web', 1080, 31),
  'WEBRip-1080p': def(16, 'WEBRip-1080p', 'webRip', 1080, 31),
  'Bluray-1080p': def(7, 'Bluray-1080p', 'bluray', 1080, 32),
  'Remux-1080p': def(20, 'Remux-1080p', 'blurayRaw', 1080, 33, ['series', 'movie'], 'remux'),
  // UHD 2160
  'HDTV-2160p': def(17, 'HDTV-2160p', 'television', 2160, 40),
  'WEBDL-2160p': def(18, 'WEBDL-2160p', 'web', 2160, 41),
  'WEBRip-2160p': def(19, 'WEBRip-2160p', 'webRip', 2160, 41),
  'Bluray-2160p': def(21, 'Bluray-2160p', 'bluray', 2160, 42),
  'Remux-2160p': def(29, 'Remux-2160p', 'blurayRaw', 2160, 43, ['series', 'movie'], 'remux'),
  // Raw broadcast
  'Raw-HD': def(10, 'Raw-HD', 'televisionRaw', 1080, 44, ['series'], 'rawhd'),
  'BR-DISK': def(30, 'BR-DISK', 'blurayRaw', 1080, 45, ['movie'], 'brdisk'),

  // ---- Music (ids 100-199). Weights rank within the music domain only. ----------------
  'MP3-Low': audio(101, 'MP3-Low', 1, 'music', lossy(['MP3'], { maxKbps: 159 })),
  'AAC-Low': audio(110, 'AAC-Low', 2, 'music', lossy(['AAC'], { maxKbps: 191 })),
  'MP3-192': audio(102, 'MP3-192', 3, 'music', lossy(['MP3'], { minKbps: 160, maxKbps: 223 })),
  Vorbis: audio(115, 'Vorbis', 4, 'music', lossy(['Vorbis'])),
  Opus: audio(116, 'Opus', 5, 'music', lossy(['Opus'])),
  'MP3-VBR-V2': audio(103, 'MP3-VBR-V2', 6, 'music', lossy(['MP3'], { vbr: 'V2' })),
  'MP3-256': audio(104, 'MP3-256', 7, 'music', lossy(['MP3'], { minKbps: 224, maxKbps: 255 })),
  'AAC-256': audio(111, 'AAC-256', 8, 'music', lossy(['AAC'], { minKbps: 192, maxKbps: 287 })),
  'MP3-VBR-V0': audio(105, 'MP3-VBR-V0', 9, 'music', lossy(['MP3'], { vbr: 'V0' })),
  'MP3-320': audio(106, 'MP3-320', 10, 'music', lossy(['MP3'], { minKbps: 256 })),
  'AAC-320': audio(112, 'AAC-320', 11, 'music', lossy(['AAC'], { minKbps: 288 })),
  'Lossless-Other': audio(132, 'Lossless-Other', 20, 'music', lossless(['APE', 'WavPack'])),
  PCM: audio(133, 'PCM', 21, 'music', lossless(['WAV', 'AIFF'])),
  ALAC: audio(130, 'ALAC', 22, 'music', lossless(['ALAC'], 16)),
  FLAC: audio(131, 'FLAC', 23, 'music', lossless(['FLAC'], 16)),
  'ALAC-24bit': audio(140, 'ALAC-24bit', 30, 'music', lossless(['ALAC'], 24)),
  'FLAC-24bit': audio(141, 'FLAC-24bit', 31, 'music', lossless(['FLAC'], 24)),
  DSD: audio(150, 'DSD', 32, 'music', lossless(['DSD'])),

  // ---- Audiobooks (ids 200-249). Weights rank within the audiobook domain only. -------
  'AB-MP3-Low': audio(201, 'AB-MP3-Low', 1, 'audiobook', lossy(['MP3'], { maxKbps: 63 })),
  'AB-AAC-Low': audio(210, 'AB-AAC-Low', 2, 'audiobook', lossy(['AAC'], { maxKbps: 63 })),
  'AB-MP3': audio(202, 'AB-MP3', 3, 'audiobook', lossy(['MP3'], { minKbps: 64, maxKbps: 127 })),
  'AB-MP3-High': audio(203, 'AB-MP3-High', 4, 'audiobook', lossy(['MP3'], { minKbps: 128 })),
  'AB-Opus': audio(212, 'AB-Opus', 5, 'audiobook', lossy(['Opus'])),
  'AB-AAC': audio(211, 'AB-AAC', 6, 'audiobook', lossy(['AAC'], { minKbps: 64 })),
  'AB-Lossless': audio(220, 'AB-Lossless', 7, 'audiobook', lossless(['FLAC', 'ALAC', 'WAV', 'AIFF', 'APE', 'WavPack'])),
} as const satisfies Record<string, QualityDefinition>;

export type QualityName = keyof typeof QUALITIES;

/** Every quality of every domain. Video code wants `VIDEO_QUALITIES` (or `qualitiesForDomain`). */
export const ALL_QUALITIES: ReadonlyArray<QualityDefinition> = Object.values(QUALITIES);

/** The domain a quality belongs to. `Unknown` (id 0) counts as video, where it always lived. */
export function qualityDomain(q: Pick<QualityDefinition, 'mediaTypes'>): MediaDomain {
  if (q.mediaTypes.includes('music')) return 'music';
  if (q.mediaTypes.includes('audiobook')) return 'audiobook';
  return 'video';
}

/** The domain of a media type. */
export function mediaDomainOf(mediaType: QualityMediaType): MediaDomain {
  return mediaType === 'music' ? 'music' : mediaType === 'audiobook' ? 'audiobook' : 'video';
}

/** True for qualities that describe audio files (music or audiobook). */
export function isAudioQuality(q: Pick<QualityDefinition, 'mediaTypes'>): boolean {
  return qualityDomain(q) !== 'video';
}

/** The series/movie vocabulary, exactly as it was before audio qualities existed. */
export const VIDEO_QUALITIES: ReadonlyArray<QualityDefinition> = ALL_QUALITIES.filter((q) => qualityDomain(q) === 'video');
export const MUSIC_QUALITIES: ReadonlyArray<QualityDefinition> = ALL_QUALITIES.filter((q) => qualityDomain(q) === 'music');
export const AUDIOBOOK_QUALITIES: ReadonlyArray<QualityDefinition> = ALL_QUALITIES.filter(
  (q) => qualityDomain(q) === 'audiobook',
);

/**
 * The qualities a profile of this domain may list. Audio domains also get `Unknown` first, so
 * a file whose quality could not be read still has a rank (the lowest).
 */
export function qualitiesForDomain(domain: MediaDomain): ReadonlyArray<QualityDefinition> {
  if (domain === 'video') return VIDEO_QUALITIES;
  return [QUALITIES.Unknown, ...(domain === 'music' ? MUSIC_QUALITIES : AUDIOBOOK_QUALITIES)];
}

/** Whether a quality id may appear in a profile of this domain. */
export function qualityInDomain(id: number, domain: MediaDomain): boolean {
  return qualitiesForDomain(domain).some((q) => q.id === id);
}

export function qualityById(id: number): QualityDefinition {
  return ALL_QUALITIES.find((q) => q.id === id) ?? QUALITIES.Unknown;
}

export function qualityByName(name: string): QualityDefinition | undefined {
  return (QUALITIES as Record<string, QualityDefinition>)[name];
}

export const QualityDefinitionSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  source: QualitySource,
  resolution: Resolution,
  modifier: QualityModifier,
  weight: z.number().int(),
  mediaTypes: z.array(QualityMediaType),
  /** Audio qualities only. */
  audio: AudioQualityDescriptor.optional(),
});

/** Proper/repack/real/version information attached to a quality. */
export const Revision = z.object({
  version: z.number().int().min(1).default(1),
  real: z.number().int().min(0).default(0),
  isRepack: z.boolean().default(false),
});
export type Revision = z.infer<typeof Revision>;

export const QualityModel = z.object({
  quality: QualityDefinitionSchema,
  revision: Revision,
});
export type QualityModel = z.infer<typeof QualityModel>;
