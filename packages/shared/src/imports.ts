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
  // Music import (docs/design/music-audiobooks.md 9.2).
  'unknownArtist',
  'unknownAlbum',
  /** A file maps to no track of the release, or two files map to the same track. */
  'trackMapping',
  /** One file next to a cue sheet: a disc image, which needs manual import. */
  'cueImage',
  /** Files of more than one edition of the album in one folder. */
  'mixedReleases',
  // Audiobook import (docs/design/music-audiobooks.md 9.3).
  'unknownAuthor',
  'unknownBook',
  /** The files' total duration is outside the tolerance around the book's runtime. */
  'durationMismatch',
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
// Manual import, audio mode (music; docs/design/music-audiobooks.md 9.2)
// ---------------------------------------------------------------------------------------

const flag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/**
 * GET /manualimport/audio: scan `folder` (or the tracked download's output folder) and propose
 * an artist, album, edition and track for every audio file. `artistId` / `albumId` pin the
 * proposal (the user picked them); otherwise the download's target or a tag lookup decides.
 */
export const AudioManualImportQuery = z
  .object({
    /** `music` (when omitted) proposes tracks; `audiobook` proposes books and part order. */
    mediaType: z.enum(['music', 'audiobook']).optional(),
    folder: z.string().min(1).optional(),
    downloadId: z.string().min(1).optional(),
    artistId: z.coerce.number().int().optional(),
    /** Match every group against this album only. */
    albumId: z.coerce.number().int().optional(),
    /** Audiobooks: pin the author (like `artistId`). */
    authorId: z.coerce.number().int().optional(),
    /** Audiobooks: match every group against this book only. */
    bookId: z.coerce.number().int().optional(),
    filterExistingFiles: flag.default(true),
  })
  .refine((q) => q.folder !== undefined || q.downloadId !== undefined || q.artistId !== undefined || q.authorId !== undefined, {
    message: 'folder, downloadId, artistId or authorId is required',
  });
export type AudioManualImportQuery = z.infer<typeof AudioManualImportQuery>;
export type AudioManualImportQueryInput = z.input<typeof AudioManualImportQuery>;

/** What the file's own tags say (shown next to the proposed track). */
export const AudioManualImportFileTags = z.object({
  title: z.string().nullable(),
  artist: z.string().nullable(),
  albumArtist: z.string().nullable(),
  album: z.string().nullable(),
  trackNo: z.number().int().nullable(),
  discNo: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  codec: z.string().nullable(),
  bitrateKbps: z.number().int().nullable(),
  sampleRateHz: z.number().int().nullable(),
  bitDepth: z.number().int().nullable(),
});
export type AudioManualImportFileTags = z.infer<typeof AudioManualImportFileTags>;

/**
 * One audio file with the mapping Arclight proposes. Files of one album folder share
 * `groupKey`; `confidence` is the group's release match (0-1), `trackScore` this file's fit to
 * its proposed track. Ids are absent when nothing was proposed.
 */
export const AudioManualImportItem = z.object({
  path: z.string(),
  relativePath: z.string(),
  name: z.string(),
  sizeBytes: z.number().int(),
  quality: QualityModel,
  mediaType: z.literal('music'),
  groupKey: z.string(),
  /** The album folder of the group (disc sub-folders fold into it). */
  groupFolder: z.string(),
  artistId: z.number().int().optional(),
  albumId: z.number().int().optional(),
  /** album_releases.id the tracks belong to (the album's selected edition). */
  albumReleaseId: z.number().int().optional(),
  /** The proposed track (one id; an array like `episodeIds`). */
  trackIds: z.array(z.number().int()).optional(),
  mediumNumber: z.number().int().optional(),
  trackNumber: z.number().int().optional(),
  trackTitle: z.string().optional(),
  confidence: z.number().min(0).max(1),
  trackScore: z.number().min(0).max(1).optional(),
  tags: AudioManualImportFileTags,
  rejections: z.array(ImportRejection),
  /** Accepted with a note (e.g. the album is incomplete and stays wanted). */
  warnings: z.array(z.string()),
  downloadId: z.string().optional(),
});
export type AudioManualImportItem = z.infer<typeof AudioManualImportItem>;

/** What an audiobook file's own tags say. */
export const AudiobookManualImportFileTags = z.object({
  title: z.string().nullable(),
  /** Artist / album artist tag (usually the author). */
  author: z.string().nullable(),
  album: z.string().nullable(),
  narrator: z.string().nullable(),
  series: z.string().nullable(),
  seriesPart: z.string().nullable(),
  asin: z.string().nullable(),
  isbn: z.string().nullable(),
  trackNo: z.number().int().nullable(),
  discNo: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  chapterCount: z.number().int().nullable(),
  codec: z.string().nullable(),
  bitrateKbps: z.number().int().nullable(),
});
export type AudiobookManualImportFileTags = z.infer<typeof AudiobookManualImportFileTags>;

/**
 * One audiobook file with the book and part Arclight proposes (GET /manualimport/audio with
 * `mediaType=audiobook`). Files of one book share `groupKey`; `partNumber` is the proposed
 * order (disc tag, then track tag, then natural file-name sort); `confidence` is the group's
 * book match (0-1). `groupDurationMs` sums the group, `runtimeMs` is the book's catalogue runtime.
 */
export const AudiobookManualImportItem = z.object({
  path: z.string(),
  relativePath: z.string(),
  name: z.string(),
  sizeBytes: z.number().int(),
  quality: QualityModel,
  mediaType: z.literal('audiobook'),
  groupKey: z.string(),
  groupFolder: z.string(),
  authorId: z.number().int().optional(),
  bookId: z.number().int().optional(),
  bookTitle: z.string().optional(),
  partNumber: z.number().int().min(1),
  partCount: z.number().int().min(1),
  confidence: z.number().min(0).max(1),
  groupDurationMs: z.number().int().nullable(),
  runtimeMs: z.number().int().nullable(),
  tags: AudiobookManualImportFileTags,
  rejections: z.array(ImportRejection),
  /** Accepted with a note (e.g. a narrator mismatch). */
  warnings: z.array(z.string()),
  downloadId: z.string().optional(),
});
export type AudiobookManualImportItem = z.infer<typeof AudiobookManualImportItem>;

/** GET /manualimport/audio answers music or audiobook items, as `mediaType` asked. */
export const AnyAudioManualImportItem = z.union([AudioManualImportItem, AudiobookManualImportItem]);
export type AnyAudioManualImportItem = z.infer<typeof AnyAudioManualImportItem>;

/** One audio file to import with the user's mapping. Specs are bypassed, like video manual import. */
export const AudioManualImportRequestItem = z.object({
  path: z.string().min(1),
  mediaType: z.literal('music').default('music'),
  artistId: z.number().int(),
  albumId: z.number().int(),
  /** When given it must be the album's selected edition (switch editions with PUT /album/:id first). */
  albumReleaseId: z.number().int().optional(),
  /** Exactly one track of the album's selected edition. */
  trackIds: z.array(z.number().int()).length(1),
  quality: QualityModel.optional(),
  downloadId: z.string().optional(),
});
export type AudioManualImportRequestItem = z.infer<typeof AudioManualImportRequestItem>;

/**
 * One audiobook file to import into a book. Files with the same book (and download) import
 * together as one book; `partNumber` orders them (omitted: the proposed order). Specs are
 * bypassed, like video manual import.
 */
export const AudiobookManualImportRequestItem = z.object({
  path: z.string().min(1),
  mediaType: z.literal('audiobook'),
  authorId: z.number().int(),
  bookId: z.number().int(),
  partNumber: z.number().int().min(1).optional(),
  quality: QualityModel.optional(),
  downloadId: z.string().optional(),
});
export type AudiobookManualImportRequestItem = z.infer<typeof AudiobookManualImportRequestItem>;

export const AudioManualImportRequest = z.object({
  items: z.array(z.union([AudioManualImportRequestItem, AudiobookManualImportRequestItem])).min(1),
  importMode: ImportMode.default('auto'),
});
export type AudioManualImportRequest = z.infer<typeof AudioManualImportRequest>;
export type AudioManualImportRequestInput = z.input<typeof AudioManualImportRequest>;

export const AudioManualImportResult = z.object({
  imported: z.array(
    z.object({
      path: z.string(),
      audioFileId: z.number().int(),
      /** Music: the track the file was linked to. */
      trackId: z.number().int().optional(),
      /** Audiobooks: the book and the file's part number. */
      bookId: z.number().int().optional(),
      partNumber: z.number().int().optional(),
      destination: z.string(),
    }),
  ),
  failed: z.array(z.object({ path: z.string(), error: z.string() })),
});
export type AudioManualImportResult = z.infer<typeof AudioManualImportResult>;

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
