import { z } from 'zod';

// The quality vocabulary every part of Media-Tron speaks: parser output, profile ranking,
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

export interface QualityDefinition {
  id: number;
  name: string;
  source: QualitySource;
  resolution: Resolution;
  modifier: QualityModifier;
  /** Default ranking weight: higher is better. Profiles can reorder. */
  weight: number;
  /** Applies to series, movies, or both. */
  mediaTypes: ReadonlyArray<'series' | 'movie'>;
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
} as const satisfies Record<string, QualityDefinition>;

export type QualityName = keyof typeof QUALITIES;

export const ALL_QUALITIES: ReadonlyArray<QualityDefinition> = Object.values(QUALITIES);

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
  mediaTypes: z.array(z.enum(['series', 'movie'])),
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
