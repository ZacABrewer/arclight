import { z } from 'zod';
import { MediaType } from './library.js';
import { QualityModel } from './quality.js';

// Imports contract: manual import, rename preview, rescan, filesystem browser. Behaviour:
// docs/spec/import.md. The `mediaManagement` settings shape lives in settings.ts and the
// naming configuration in naming.ts (GET/PUT /settings/naming use `NamingConfig`).

/** Why a file cannot be imported automatically (spec 7.4, Sonarr and Radarr merged). */
export const ImportRejectionReason = z.enum([
  'unknown',
  'fileLocked',
  'unknownSeries',
  'unknownMovie',
  'dangerousFile',
  'executableFile',
  'archiveFile',
  'seriesFolder',
  'movieFolder',
  'invalidFilePath',
  'unsupportedExtension',
  'invalidSeasonOrEpisode',
  'partialSeason',
  'seasonExtra',
  'multiSeason',
  'unableToParse',
  'error',
  'alreadyImported',
  'minimumFreeSpace',
  'noAudio',
  'notFoundInRelease',
  'episodeUnexpected',
  'sample',
  'sampleIndeterminate',
  'unpacking',
  'existingFileHasMoreEpisodes',
  'splitEpisode',
  'unverifiedSceneMapping',
  'fullSeason',
  'titleMissing',
  'titleTba',
  'missingAbsoluteEpisodeNumber',
  'notQualityUpgrade',
  'notRevisionUpgrade',
  'notCustomFormatUpgrade',
  'sameFile',
  'episodeCountMismatch',
  'noEpisodes',
]);
export type ImportRejectionReason = z.infer<typeof ImportRejectionReason>;

export const ImportRejection = z.object({
  reason: ImportRejectionReason,
  message: z.string(),
  /** Temporary rejections may pass on a later attempt (still unpacking, sample undetermined). */
  type: z.enum(['permanent', 'temporary']),
});
export type ImportRejection = z.infer<typeof ImportRejection>;

export const ImportMode = z.enum(['move', 'copy', 'auto']);
export type ImportMode = z.infer<typeof ImportMode>;

// ---------------------------------------------------------------------------------------
// Manual import
// ---------------------------------------------------------------------------------------

/** GET /manualimport: one of folder, downloadId, seriesId or movieId. */
export const ManualImportQuery = z
  .object({
    folder: z.string().min(1).optional(),
    downloadId: z.string().min(1).optional(),
    seriesId: z.coerce.number().int().optional(),
    movieId: z.coerce.number().int().optional(),
    filterExistingFiles: z
      .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
      .transform((v) => v === true || v === 'true' || v === '1')
      .default(true),
  })
  .refine((q) => q.folder !== undefined || q.downloadId !== undefined || q.seriesId !== undefined || q.movieId !== undefined, {
    message: 'folder, downloadId, seriesId or movieId is required',
  });
export type ManualImportQuery = z.infer<typeof ManualImportQuery>;
export type ManualImportQueryInput = z.input<typeof ManualImportQuery>;

/** A candidate file with the mapping Arclight suggests and the reasons it would be rejected. */
export const ManualImportItem = z.object({
  path: z.string(),
  /** Relative to the folder being listed. */
  relativePath: z.string(),
  /** File name without folders. */
  name: z.string(),
  sizeBytes: z.number().int(),
  quality: QualityModel,
  languages: z.array(z.string()),
  releaseGroup: z.string().nullable(),
  mediaType: MediaType.optional(),
  seriesId: z.number().int().optional(),
  seasonNumber: z.number().int().optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
  rejections: z.array(ImportRejection),
  downloadId: z.string().optional(),
});
export type ManualImportItem = z.infer<typeof ManualImportItem>;

/** One file to import with the user's chosen mapping. Specs are bypassed (spec 11.5). */
export const ManualImportRequestItem = z
  .object({
    path: z.string().min(1),
    mediaType: MediaType,
    seriesId: z.number().int().optional(),
    seasonNumber: z.number().int().optional(),
    episodeIds: z.array(z.number().int()).optional(),
    movieId: z.number().int().optional(),
    quality: QualityModel.optional(),
    languages: z.array(z.string()).optional(),
    releaseGroup: z.string().nullable().optional(),
    downloadId: z.string().optional(),
    /** Multi-version items: the version slot to fill; omitted = the best-fitting version. */
    versionTag: z.string().optional(),
  })
  .refine(
    (i) => (i.mediaType === 'series' ? i.seriesId !== undefined && (i.episodeIds?.length ?? 0) > 0 : i.movieId !== undefined),
    { message: 'series items need seriesId and episodeIds; movie items need movieId' },
  );
export type ManualImportRequestItem = z.infer<typeof ManualImportRequestItem>;

export const ManualImportRequest = z.object({
  items: z.array(ManualImportRequestItem).min(1),
  importMode: ImportMode.default('auto'),
});
export type ManualImportRequest = z.infer<typeof ManualImportRequest>;
export type ManualImportRequestInput = z.input<typeof ManualImportRequest>;

export const ManualImportResult = z.object({
  imported: z.array(z.object({ path: z.string(), mediaFileId: z.number().int(), destination: z.string() })),
  failed: z.array(z.object({ path: z.string(), error: z.string() })),
});
export type ManualImportResult = z.infer<typeof ManualImportResult>;

// ---------------------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------------------

export const RenamePreviewQuery = z
  .object({
    seriesId: z.coerce.number().int().optional(),
    movieId: z.coerce.number().int().optional(),
    seasonNumber: z.coerce.number().int().optional(),
  })
  .refine((q) => (q.seriesId === undefined) !== (q.movieId === undefined), {
    message: 'exactly one of seriesId or movieId is required',
  });
export type RenamePreviewQuery = z.infer<typeof RenamePreviewQuery>;

export const RenamePreviewItem = z.object({
  mediaFileId: z.number().int(),
  mediaType: MediaType,
  seriesId: z.number().int().optional(),
  movieId: z.number().int().optional(),
  seasonNumber: z.number().int().optional(),
  episodeNumbers: z.array(z.number().int()).optional(),
  /** Relative to the series/movie folder. */
  existingPath: z.string(),
  newPath: z.string(),
});
export type RenamePreviewItem = z.infer<typeof RenamePreviewItem>;

/** POST /command/rename. `files` limits the rename to those media file ids. */
export const RenameCommand = z
  .object({
    seriesId: z.number().int().optional(),
    movieId: z.number().int().optional(),
    files: z.array(z.number().int()).optional(),
  })
  .refine((q) => (q.seriesId === undefined) !== (q.movieId === undefined), {
    message: 'exactly one of seriesId or movieId is required',
  });
export type RenameCommand = z.infer<typeof RenameCommand>;

export const RenameResult = z.object({
  renamed: z.array(RenamePreviewItem),
  failed: z.array(z.object({ mediaFileId: z.number().int(), error: z.string() })),
});
export type RenameResult = z.infer<typeof RenameResult>;

// ---------------------------------------------------------------------------------------
// Rescan
// ---------------------------------------------------------------------------------------

/** POST /command/rescan. Neither id: rescan everything. */
export const RescanCommand = z.object({
  seriesId: z.number().int().optional(),
  movieId: z.number().int().optional(),
});
export type RescanCommand = z.infer<typeof RescanCommand>;

export const RescanResult = z.object({
  scanned: z.number().int(),
  added: z.array(z.object({ path: z.string(), mediaFileId: z.number().int() })),
  removed: z.array(z.object({ path: z.string(), mediaFileId: z.number().int() })),
  /** Video files on disk that could not be mapped to an episode/movie. */
  unmapped: z.array(z.string()),
});
export type RescanResult = z.infer<typeof RescanResult>;

// ---------------------------------------------------------------------------------------
// Filesystem browser (path picker)
// ---------------------------------------------------------------------------------------

export const FileSystemQuery = z.object({
  /** Absent or empty: the filesystem roots (drives on Windows, `/` elsewhere). */
  path: z.string().optional(),
  includeFiles: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
  /** Accept `C:\Media` as well as `C:\Media\` (always true; kept for *arr-style clients). */
  allowFoldersWithoutTrailingSlashes: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
});
export type FileSystemQuery = z.infer<typeof FileSystemQuery>;

export const FileSystemEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['directory', 'file', 'drive']),
  sizeBytes: z.number().int().optional(),
  lastModified: z.string().optional(),
});
export type FileSystemEntry = z.infer<typeof FileSystemEntry>;

export const FileSystemListing = z.object({
  path: z.string(),
  /** Null at a root. */
  parent: z.string().nullable(),
  directories: z.array(FileSystemEntry),
  files: z.array(FileSystemEntry),
});
export type FileSystemListing = z.infer<typeof FileSystemListing>;

/** POST /filesystem/mkdir: create `name` inside `parent` (or the absolute `path`). */
export const FileSystemMkdirRequest = z
  .object({
    path: z.string().min(1).optional(),
    parent: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  })
  .refine((r) => r.path !== undefined || (r.parent !== undefined && r.name !== undefined), {
    message: 'path, or parent and name, is required',
  });
export type FileSystemMkdirRequest = z.infer<typeof FileSystemMkdirRequest>;

export const ImportsErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type ImportsErrorResponse = z.infer<typeof ImportsErrorResponse>;
