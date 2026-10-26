import { z } from 'zod';
import { MediaType } from './library.js';

// Library hygiene: files on disk the library does not know (orphans), duplicate files and
// empty folders, found by the OrphanScan job and listed for review.

export const HygieneFindingType = z.enum(['orphan', 'duplicate', 'empty']);
export type HygieneFindingType = z.infer<typeof HygieneFindingType>;

/**
 * Why files were grouped as duplicates: `episode`/`movie` = a file on disk for an episode or
 * movie that already has a library file (or a second library row for one movie); `content` =
 * identical size and leading-bytes hash.
 */
export const DuplicateReason = z.enum(['episode', 'movie', 'content']);
export type DuplicateReason = z.infer<typeof DuplicateReason>;

/** What the parser made of an orphan's path. */
export const HygieneParsedGuess = z.object({
  title: z.string().nullable(),
  year: z.number().int().nullable(),
  mediaType: MediaType.nullable(),
  seasonNumber: z.number().int().nullable(),
  episodeNumbers: z.array(z.number().int()),
  quality: z.string().nullable(),
  releaseGroup: z.string().nullable(),
});
export type HygieneParsedGuess = z.infer<typeof HygieneParsedGuess>;

export const HygieneSuggestion = z.object({
  mediaType: MediaType,
  seriesId: z.number().int().optional(),
  movieId: z.number().int().optional(),
  title: z.string(),
  year: z.number().int(),
  /** 0..1; 1 when the file sits inside the item's folder. */
  score: z.number(),
  /** Series suggestions: the episodes the parsed season/episode numbers point at. */
  episodeIds: z.array(z.number().int()).optional(),
  seasonNumber: z.number().int().optional(),
});
export type HygieneSuggestion = z.infer<typeof HygieneSuggestion>;

export const HygieneFinding = z.object({
  id: z.number().int(),
  type: HygieneFindingType,
  path: z.string(),
  rootFolderPath: z.string(),
  sizeBytes: z.number().int(),
  /** Duplicates: the library file this path is, when it is one. */
  mediaFileId: z.number().int().nullable(),
  seriesId: z.number().int().nullable(),
  movieId: z.number().int().nullable(),
  duplicateReason: DuplicateReason.nullable(),
  /** Duplicates: the other paths in the same group. */
  duplicateOf: z.array(z.string()),
  parsed: HygieneParsedGuess.nullable(),
  suggestions: z.array(HygieneSuggestion),
  foundAt: z.string(),
});
export type HygieneFinding = z.infer<typeof HygieneFinding>;

export const HygieneListQuery = z.object({
  type: HygieneFindingType.optional(),
  rootFolderPath: z.string().optional(),
});
export type HygieneListQuery = z.infer<typeof HygieneListQuery>;

export const HygieneListResponse = z.object({
  lastScan: z.string().nullable(),
  counts: z.object({ orphan: z.number().int(), duplicate: z.number().int(), empty: z.number().int() }),
  records: z.array(HygieneFinding),
});
export type HygieneListResponse = z.infer<typeof HygieneListResponse>;

/** Map an orphan into the library through manual import. Omitted fields use the best suggestion. */
export const HygieneMapRequest = z.object({
  mediaType: MediaType.optional(),
  seriesId: z.number().int().optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
  importMode: z.enum(['auto', 'move', 'copy']).default('move'),
});
export type HygieneMapRequest = z.infer<typeof HygieneMapRequest>;
export type HygieneMapRequestInput = z.input<typeof HygieneMapRequest>;

export const HygieneMapResult = z.object({
  mediaFileId: z.number().int(),
  destination: z.string(),
});
export type HygieneMapResult = z.infer<typeof HygieneMapResult>;

export const HygieneDeleteResult = z.object({
  /** Where the file went; null when deleted outright (no recycle bin) or for folders. */
  recycledTo: z.string().nullable(),
  removedMediaFileId: z.number().int().nullable(),
});
export type HygieneDeleteResult = z.infer<typeof HygieneDeleteResult>;

export const HygieneScanSummary = z.object({
  rootFolders: z.number().int(),
  filesScanned: z.number().int(),
  orphans: z.number().int(),
  duplicates: z.number().int(),
  emptyFolders: z.number().int(),
  skippedRootFolders: z.array(z.string()),
});
export type HygieneScanSummary = z.infer<typeof HygieneScanSummary>;
