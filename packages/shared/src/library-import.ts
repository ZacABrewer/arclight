import { z } from 'zod';

// Library import of existing music and audiobook files (docs/API.md "libraryimport"): scan a
// root folder for album / book folders that are not linked to the library yet, propose a
// MusicBrainz release group or catalogue book for each, then add the artist / author (only the
// imported items monitored, no search) and link the files where they are.

export const LibraryImportMediaType = z.enum(['music', 'audiobook']);
export type LibraryImportMediaType = z.infer<typeof LibraryImportMediaType>;

/** POST /libraryimport/scan. */
export const LibraryImportScanRequest = z.object({
  mediaType: LibraryImportMediaType,
  /** Absolute folder to scan: a root folder or any folder below one. */
  path: z.string().min(1),
  /**
   * The library root new artists / authors go under. Defaults to the registered root folder
   * (of the media type) that contains `path`; required when `path` is outside every root.
   */
  rootFolderPath: z.string().min(1).optional(),
});
export type LibraryImportScanRequest = z.infer<typeof LibraryImportScanRequest>;

export const LibraryImportScanStatus = z.enum(['scanning', 'matching', 'ready', 'importing', 'failed']);
export type LibraryImportScanStatus = z.infer<typeof LibraryImportScanStatus>;

/** A proposed (or searched) match: a catalogue book (`foreignId` = ASIN) or a release group (MBID). */
export const LibraryImportMatch = z.object({
  /** Book ASIN, or MusicBrainz release-group id. */
  foreignId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  /** The book's primary author / the release group's first credited artist. */
  creditName: z.string().nullable(),
  /** Author ASIN / artist MBID, when the source knows it. */
  creditForeignId: z.string().nullable(),
  year: z.number().int().nullable(),
  coverUrl: z.string().nullable(),
  /** Audiobooks: narrators and catalogue runtime. */
  narrators: z.array(z.string()),
  runtimeMinutes: z.number().int().nullable(),
  series: z.string().nullable(),
  seriesPosition: z.string().nullable(),
  /** Music: release-group type ("Album", "EP" ...). */
  albumType: z.string().nullable(),
  /** The book / album is already in the library (its files are linked to it). */
  inLibrary: z.boolean(),
  /** 0-1: how well it fits the folder (1 for an id found in the tags). */
  score: z.number().min(0).max(1),
});
export type LibraryImportMatch = z.infer<typeof LibraryImportMatch>;

export const LibraryImportFile = z.object({
  path: z.string(),
  relativePath: z.string(),
  sizeBytes: z.number().int(),
  durationMs: z.number().int().nullable(),
  /** False when no reader could parse the tags (the file is still imported by its folder). */
  readable: z.boolean(),
});
export type LibraryImportFile = z.infer<typeof LibraryImportFile>;

/** What the folder, file names and tags say about the item. */
export const LibraryImportDetected = z.object({
  /** Author (audiobooks) or album artist (music). */
  author: z.string().nullable(),
  title: z.string().nullable(),
  series: z.string().nullable(),
  seriesPosition: z.string().nullable(),
  narrator: z.string().nullable(),
  year: z.number().int().nullable(),
  asin: z.string().nullable(),
  isbn: z.string().nullable(),
  mbReleaseGroupId: z.string().nullable(),
  mbReleaseId: z.string().nullable(),
  mbArtistId: z.string().nullable(),
});
export type LibraryImportDetected = z.infer<typeof LibraryImportDetected>;

export const LibraryImportCandidateStatus = z.enum(['pending', 'importing', 'imported', 'failed']);
export type LibraryImportCandidateStatus = z.infer<typeof LibraryImportCandidateStatus>;

/** One book or album folder found by the scan. */
export const LibraryImportCandidate = z.object({
  /** Stable within the scan. */
  id: z.string(),
  mediaType: LibraryImportMediaType,
  /** The book / album folder (disc and part sub-folders fold into it). */
  folder: z.string(),
  /** `folder` relative to the scanned path ("." for the path itself). */
  relativeFolder: z.string(),
  files: z.array(LibraryImportFile),
  sizeBytes: z.number().int(),
  /** Sum of the files' durations; null when one is unknown. */
  durationMs: z.number().int().nullable(),
  detected: LibraryImportDetected,
  match: LibraryImportMatch.nullable(),
  /** Other fitting books / release groups, best first. */
  alternatives: z.array(LibraryImportMatch),
  /** 0-1, the proposed match's score (0 without a match). */
  confidence: z.number().min(0).max(1),
  matchedBy: z.enum(['asin', 'isbn', 'mbid', 'search', 'none']),
  /** Notes that do not block the import (duration off the runtime, unreadable files ...). */
  warnings: z.array(z.string()),
  status: LibraryImportCandidateStatus,
  /** Result of the import (or why it failed). */
  message: z.string().nullable(),
});
export type LibraryImportCandidate = z.infer<typeof LibraryImportCandidate>;

export const LibraryImportProgress = z.object({
  /** Folders or items handled so far in the current phase, of `total` (0 while unknown). */
  done: z.number().int(),
  total: z.number().int(),
});
export type LibraryImportProgress = z.infer<typeof LibraryImportProgress>;

/** A scan without its candidates (GET /libraryimport/scan). */
export const LibraryImportScanSummary = z.object({
  id: z.string(),
  mediaType: LibraryImportMediaType,
  path: z.string(),
  rootFolderPath: z.string(),
  status: LibraryImportScanStatus,
  progress: LibraryImportProgress,
  /** The running scan or import job. */
  jobId: z.number().int().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  stats: z.object({
    /** Audio files found under `path`. */
    files: z.number().int(),
    /** Of those, files already linked to the library (left out). */
    alreadyInLibrary: z.number().int(),
    /** Files no reader could parse. */
    unreadable: z.number().int(),
    candidates: z.number().int(),
    imported: z.number().int(),
    failed: z.number().int(),
  }),
});
export type LibraryImportScanSummary = z.infer<typeof LibraryImportScanSummary>;

/** GET /libraryimport/scan/:id. */
export const LibraryImportScan = LibraryImportScanSummary.extend({
  candidates: z.array(LibraryImportCandidate),
});
export type LibraryImportScan = z.infer<typeof LibraryImportScan>;

/** GET /libraryimport/lookup: search the catalogue / MusicBrainz to change a match. */
export const LibraryImportLookupQuery = z.object({
  mediaType: LibraryImportMediaType,
  /** Free text ("author title"), an ASIN, or a release-group / release MBID. */
  term: z.string().trim().min(1),
});
export type LibraryImportLookupQuery = z.infer<typeof LibraryImportLookupQuery>;

export const LibraryImportMode = z.enum(['inPlace', 'move']);
export type LibraryImportMode = z.infer<typeof LibraryImportMode>;

/** POST /libraryimport/import. */
export const LibraryImportRequest = z.object({
  scanId: z.string().min(1),
  items: z
    .array(
      z.object({
        candidateId: z.string().min(1),
        /** The chosen match (ASIN / release-group MBID); omitted: the proposed one. */
        foreignId: z.string().min(1).optional(),
      }),
    )
    .min(1),
  /**
   * `inPlace` (default): link the files where they are, no move or rename. `move`: move them into
   * the artist / author folder with the naming settings (the manual-import mover).
   */
  mode: LibraryImportMode.default('inPlace'),
  /** Quality profile of artists / authors the import adds (of the media type's domain). */
  qualityProfileId: z.number().int(),
  /** Music: album-type profile of added artists (default profile when omitted). */
  albumTypeProfileId: z.number().int().optional(),
  tags: z.array(z.number().int()).default([]),
});
export type LibraryImportRequest = z.infer<typeof LibraryImportRequest>;
export type LibraryImportRequestInput = z.input<typeof LibraryImportRequest>;
