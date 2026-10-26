import { basename, isAbsolute } from 'node:path';
import type { ParsedRelease } from '@arclight/parser';
import { requiresAbsoluteNumber, requiresEpisodeTitle } from '@arclight/organizer';
import { compareQuality, compareRevision } from '@arclight/profiles-engine';
import {
  qualityById,
  type Episode,
  type ImportRejection,
  type ImportRejectionReason,
  type MediaFile,
  type MediaManagementSettings,
  type MediaType,
  type Movie,
  type NamingConfig,
  type QualityModel,
  type QualityProfile,
  type Series,
} from '@arclight/shared';
import { DANGEROUS_EXTENSIONS, EXECUTABLE_EXTENSIONS, detectSample, isMediaExtension, isUnpacking } from './scan.js';

// Import specifications (spec section 7) as pure functions over a fully augmented local item
// and a context the service assembles. Every spec runs for every file; all rejections are
// collected (spec 5.2 step 6). A spec that throws yields an `error` rejection.

/** A candidate file after parsing, matching and augmentation. */
export interface LocalItem {
  path: string;
  sizeBytes: number;
  extension: string;
  mtimeMs: number;
  mediaType: MediaType;
  parsed: ParsedRelease | null;
  quality: QualityModel;
  languages: string[];
  releaseGroup: string | null;
  series?: Series | undefined;
  /** Library episodes the file maps to. */
  episodes: Episode[];
  /** How many episodes the parse implied (0 when unknown). */
  parsedEpisodeCount: number;
  movie?: Movie | undefined;
  /** The file already lives inside the series/movie folder (spec ExistingFile). */
  existingFile: boolean;
  /**
   * Multi-version library: the version slot this file fills (best-fitting version profile).
   * null/absent on unversioned items.
   */
  versionTag?: string | null | undefined;
  /** Library files currently attached to the matched episodes/movie in the same version slot, de-duplicated. */
  existingFiles: MediaFile[];
  formatScore: number;
  /** Custom-format score of each existing file, by media file id. */
  existingFormatScores: Readonly<Record<number, number>>;
  /** `undefined` = not probed; `null` = probe failed. */
  runtimeSeconds: number | null | undefined;
  audioStreams?: number | undefined;
}

/** What the grab recorded about the release (from the tracked download). */
export interface GrabbedInfo {
  title?: string;
  mediaType?: MediaType;
  seriesId?: number;
  episodeIds?: number[];
  movieId?: number;
  quality?: QualityModel;
}

export interface DecisionContext {
  settings: MediaManagementSettings;
  naming: NamingConfig;
  profile: QualityProfile | null;
  /** Free bytes on the destination volume; null when unknown. */
  freeSpaceBytes: number | null;
  grab: GrabbedInfo | null;
  /** The tracked download already produced an import after its latest grab. */
  alreadyImported: boolean;
  /** All episodes of the matched series (for bulk-season title checks). */
  seriesEpisodes: readonly Episode[];
  /** Number of video files in the same import batch. */
  videoCount: number;
  /** Paths of every media file already registered. */
  libraryPaths: ReadonlySet<string>;
  platform: NodeJS.Platform;
  now: Date;
}

export interface ImportDecision {
  item: LocalItem;
  approved: boolean;
  rejections: ImportRejection[];
}

export type ImportSpec = (item: LocalItem, ctx: DecisionContext) => ImportRejection | ImportRejection[] | null;

const permanent = (reason: ImportRejectionReason, message: string): ImportRejection => ({ reason, message, type: 'permanent' });
const temporary = (reason: ImportRejectionReason, message: string): ImportRejection => ({ reason, message, type: 'temporary' });

const DAY_MS = 24 * 60 * 60 * 1000;

function airedMs(e: Episode): number | null {
  const v = e.airDateUtc ?? e.airDate;
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function sxe(e: Episode): string {
  return `${e.seasonNumber}x${String(e.episodeNumber).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------
// File-level specs
// ---------------------------------------------------------------------------------------

export const absolutePathSpec: ImportSpec = (item) =>
  isAbsolute(item.path) ? null : permanent('invalidFilePath', `Path is not absolute: ${item.path}`);

export const mediaExtensionSpec: ImportSpec = (item) => {
  const name = basename(item.path);
  if (name.startsWith('._')) return permanent('invalidFilePath', 'Invalid file path');
  if (DANGEROUS_EXTENSIONS.has(item.extension)) return permanent('dangerousFile', `Caution: found potentially dangerous file with extension ${item.extension}`);
  if (EXECUTABLE_EXTENSIONS.has(item.extension)) return permanent('executableFile', `Caution: found executable file with extension ${item.extension}`);
  if (!isMediaExtension(item.extension)) return permanent('unsupportedExtension', `Invalid video file, unsupported extension: '${item.extension}'`);
  return null;
};

export const freeSpaceSpec: ImportSpec = (item, ctx) => {
  if (item.existingFile || ctx.settings.skipFreeSpaceCheck || ctx.freeSpaceBytes === null) return null;
  const needed = item.sizeBytes + ctx.settings.minimumFreeSpaceMb * 1024 * 1024;
  return ctx.freeSpaceBytes < needed ? permanent('minimumFreeSpace', 'Not enough free space') : null;
};

export const notUnpackingSpec: ImportSpec = (item, ctx) =>
  isUnpacking(item, ctx.settings.downloadClientWorkingFolders, ctx.platform, ctx.now.getTime())
    ? temporary('unpacking', 'File is still being unpacked')
    : null;

export const notSampleSpec: ImportSpec = (item) => {
  const expected =
    item.mediaType === 'movie'
      ? (item.movie?.runtimeMinutes ?? 0)
      : item.episodes.reduce((sum, e) => sum + ((e.runtimeMinutes ?? 0) > 0 ? e.runtimeMinutes! : (item.series?.runtimeMinutes ?? 0)), 0);
  const verdict = detectSample({
    path: item.path,
    mediaType: item.mediaType,
    seasonNumber: item.episodes[0]?.seasonNumber,
    existingFile: item.existingFile,
    expectedRuntimeMinutes: expected,
    runtimeSeconds: item.runtimeSeconds,
  });
  if (verdict === 'sample') return permanent('sample', 'Sample');
  if (verdict === 'indeterminate') return temporary('sampleIndeterminate', 'Unable to determine if file is a sample');
  return null;
};

export const hasAudioSpec: ImportSpec = (item) =>
  item.audioStreams === 0 ? permanent('noAudio', 'No audio tracks detected') : null;

export const sameFileSpec: ImportSpec = (item, ctx) =>
  ctx.libraryPaths.has(item.path) ? permanent('sameFile', 'File is already registered in the library') : null;

export const alreadyImportedSpec: ImportSpec = (item, ctx) => {
  if (!ctx.alreadyImported || item.existingFiles.length === 0) return null;
  return item.mediaType === 'movie'
    ? permanent('alreadyImported', 'Movie file already imported')
    : permanent('alreadyImported', 'Episode file already imported');
};

// ---------------------------------------------------------------------------------------
// Mapping specs
// ---------------------------------------------------------------------------------------

export const mappingSpec: ImportSpec = (item) => {
  if (item.mediaType === 'movie') {
    if (!item.movie) return item.parsed?.movie ? permanent('unknownMovie', 'Unknown Movie') : permanent('unableToParse', 'Unable to parse file');
    return null;
  }
  if (!item.series) return item.parsed?.series ? permanent('unknownSeries', 'Unknown Series') : permanent('unableToParse', 'Unable to parse file');
  if (item.episodes.length > 0) return null;
  const s = item.parsed?.series;
  if (s?.isPartialSeason) return permanent('partialSeason', 'Partial season packs are not supported');
  if (s?.isSeasonExtra) return permanent('seasonExtra', 'Extras are not supported');
  return permanent('invalidSeasonOrEpisode', 'Invalid season or episode');
};

export const multiSeasonSpec: ImportSpec = (item) =>
  item.mediaType === 'series' && item.parsed?.series?.isMultiSeason
    ? permanent('multiSeason', 'Multi-season download, unable to import automatically')
    : null;

export const fullSeasonSpec: ImportSpec = (item) =>
  item.mediaType === 'series' && item.parsed?.series?.fullSeason && item.parsed.series.episodes.length === 0
    ? permanent('fullSeason', 'Single episode file contains all episodes in seasons. Review file name or manually import')
    : null;

export const splitEpisodeSpec: ImportSpec = (item) =>
  item.mediaType === 'series' && item.parsed?.series?.isSplitEpisode
    ? permanent('splitEpisode', 'Single episode split into multiple files')
    : null;

export const episodeCountSpec: ImportSpec = (item) => {
  if (item.mediaType !== 'series' || item.episodes.length === 0) return null;
  if (item.parsedEpisodeCount > item.episodes.length) {
    return permanent(
      'episodeCountMismatch',
      `File covers ${item.parsedEpisodeCount} episodes but only ${item.episodes.length} exist in the library`,
    );
  }
  return null;
};

export const unverifiedSceneNumberingSpec: ImportSpec = (item) => {
  const bad = item.episodes.filter((e) => e.unverifiedSceneNumbering);
  return bad.length > 0
    ? permanent('unverifiedSceneMapping', `Episode(s) ${bad.map(sxe).join(', ')} have unverified scene numbering`)
    : null;
};

export const sameEpisodesSpec: ImportSpec = (item) => {
  if (item.mediaType !== 'series') return null;
  const more = item.existingFiles.find((f) => f.episodeIds.length > item.episodes.length);
  return more
    ? permanent('existingFileHasMoreEpisodes', 'Existing file on disk contains more episodes than this file')
    : null;
};

export const matchesGrabSpec: ImportSpec = (item, ctx) => {
  const grab = ctx.grab;
  if (!grab) return null;
  if (item.mediaType === 'movie') {
    if (grab.movieId !== undefined && item.movie && item.movie.id !== grab.movieId) {
      return permanent('notFoundInRelease', `Movie ${item.movie.title} was not found in the grabbed release`);
    }
    return null;
  }
  if (grab.seriesId !== undefined && item.series && item.series.id !== grab.seriesId) {
    return permanent('notFoundInRelease', `Series ${item.series.title} was not found in the grabbed release`);
  }
  if (grab.episodeIds && grab.episodeIds.length > 0) {
    const allowed = new Set(grab.episodeIds);
    const unexpected = item.episodes.filter((e) => !allowed.has(e.id));
    if (unexpected.length > 0) {
      return permanent('notFoundInRelease', `Episode ${unexpected.map(sxe).join(', ')} was not found in the grabbed release`);
    }
  }
  return null;
};

export const episodeTitleSpec: ImportSpec = (item, ctx) => {
  if (item.mediaType !== 'series' || !item.series || item.existingFile) return null;
  if (ctx.settings.episodeTitleRequired === 'never' || item.episodes.length === 0) return null;
  const ns = { title: item.series.title, year: item.series.year, seriesType: item.series.seriesType };
  if (!requiresEpisodeTitle(ctx.naming, ns, item.episodes.map(namingEpisode))) return null;

  if (ctx.settings.episodeTitleRequired === 'bulkSeasonReleases') {
    const dates = new Set(item.episodes.map((e) => e.airDateUtc ?? e.airDate ?? ''));
    if (dates.size === 1) {
      const [date] = [...dates];
      const season = item.episodes[0]!.seasonNumber;
      const sharing = ctx.seriesEpisodes.filter((e) => e.seasonNumber === season && (e.airDateUtc ?? e.airDate ?? '') === date).length;
      if (sharing < 4) return null;
    }
  }

  const rejections: ImportRejection[] = [];
  for (const e of item.episodes) {
    const aired = airedMs(e);
    if (aired !== null && ctx.now.getTime() - aired > 2 * DAY_MS) continue;
    const title = e.title.trim();
    if (title === '') rejections.push(temporary('titleMissing', `Episode ${sxe(e)} does not have a title and recently aired`));
    else if (title.toUpperCase() === 'TBA') rejections.push(temporary('titleTba', `Episode ${sxe(e)} has a TBA title and recently aired`));
  }
  return rejections;
};

export const absoluteNumberSpec: ImportSpec = (item, ctx) => {
  if (item.mediaType !== 'series' || !item.series || item.series.seriesType !== 'anime') return null;
  const ns = { title: item.series.title, year: item.series.year, seriesType: item.series.seriesType };
  if (!requiresAbsoluteNumber(ctx.naming, ns)) return null;
  const missing = item.episodes.filter((e) => {
    if (e.absoluteEpisodeNumber != null) return false;
    const aired = airedMs(e);
    return aired === null || ctx.now.getTime() - aired < DAY_MS;
  });
  return missing.length > 0
    ? temporary('missingAbsoluteEpisodeNumber', `Episode ${missing.map(sxe).join(', ')} has no absolute episode number and recently aired`)
    : null;
};

// ---------------------------------------------------------------------------------------
// Upgrade (spec 7.1 Upgrade)
// ---------------------------------------------------------------------------------------

function compareQ(profile: QualityProfile | null, a: QualityModel, b: QualityModel): number {
  if (profile) return compareQuality(profile, a, b);
  return Math.sign(qualityById(a.quality.id).weight - qualityById(b.quality.id).weight);
}

export const upgradeSpec: ImportSpec = (item, ctx) => {
  if (item.existingFile) return null;
  const rejections: ImportRejection[] = [];
  for (const existing of item.existingFiles) {
    const cmp = compareQ(ctx.profile, item.quality, existing.quality);
    if (cmp < 0) {
      rejections.push(permanent('notQualityUpgrade', `Not an upgrade for existing file. Existing quality: ${existing.quality.quality.name}`));
      continue;
    }
    if (cmp > 0) continue;
    if (
      ctx.settings.downloadPropersAndRepacks !== 'doNotPrefer' &&
      compareRevision(item.quality.revision, existing.quality.revision) < 0
    ) {
      rejections.push(permanent('notRevisionUpgrade', 'Not an upgrade for existing file. Existing file has a better revision'));
      continue;
    }
    const existingScore = item.existingFormatScores[existing.id] ?? 0;
    if (item.formatScore < existingScore) {
      rejections.push(
        permanent('notCustomFormatUpgrade', `Not a custom format upgrade for existing file. New: ${item.formatScore}, existing: ${existingScore}`),
      );
    }
  }
  return rejections;
};

// ---------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------

export const IMPORT_SPECS: ReadonlyArray<[string, ImportSpec]> = [
  ['absolutePath', absolutePathSpec],
  ['mediaExtension', mediaExtensionSpec],
  ['mapping', mappingSpec],
  ['multiSeason', multiSeasonSpec],
  ['fullSeason', fullSeasonSpec],
  ['splitEpisode', splitEpisodeSpec],
  ['episodeCount', episodeCountSpec],
  ['freeSpace', freeSpaceSpec],
  ['notUnpacking', notUnpackingSpec],
  ['notSample', notSampleSpec],
  ['hasAudio', hasAudioSpec],
  ['sameFile', sameFileSpec],
  ['alreadyImported', alreadyImportedSpec],
  ['matchesGrab', matchesGrabSpec],
  ['unverifiedSceneNumbering', unverifiedSceneNumberingSpec],
  ['sameEpisodes', sameEpisodesSpec],
  ['episodeTitle', episodeTitleSpec],
  ['absoluteNumber', absoluteNumberSpec],
  ['upgrade', upgradeSpec],
];

export function evaluate(item: LocalItem, ctx: DecisionContext, specs: ReadonlyArray<[string, ImportSpec]> = IMPORT_SPECS): ImportDecision {
  const rejections: ImportRejection[] = [];
  for (const [name, spec] of specs) {
    try {
      const out = spec(item, ctx);
      if (out === null) continue;
      if (Array.isArray(out)) rejections.push(...out);
      else rejections.push(out);
    } catch (err) {
      rejections.push(permanent('error', `${name}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  return { item, approved: rejections.length === 0, rejections };
}

/**
 * Import order (spec 9.1): best quality first, then largest. The caller then imports in this
 * order and rejects later decisions whose episodes/movie were already imported in the batch.
 */
export function orderForImport(decisions: readonly ImportDecision[], profile: QualityProfile | null): ImportDecision[] {
  return [...decisions].sort((a, b) => {
    const q = compareQ(profile, b.item.quality, a.item.quality);
    if (q !== 0) return q;
    return b.item.sizeBytes - a.item.sizeBytes;
  });
}

export function namingEpisode(e: Episode) {
  return {
    seasonNumber: e.seasonNumber,
    episodeNumber: e.episodeNumber,
    absoluteEpisodeNumber: e.absoluteEpisodeNumber ?? null,
    title: e.title,
    airDate: e.airDate ?? null,
  };
}

/** Reads what it can from the opaque grab snapshot; tolerant of shapes from the releases module. */
export function readGrabbedRelease(raw: unknown): GrabbedInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: GrabbedInfo = {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
  if (typeof r['title'] === 'string') out.title = r['title'];
  if (r['mediaType'] === 'series' || r['mediaType'] === 'movie') out.mediaType = r['mediaType'];
  const seriesId = num(r['seriesId']);
  if (seriesId !== undefined) out.seriesId = seriesId;
  const movieId = num(r['movieId']);
  if (movieId !== undefined) out.movieId = movieId;
  if (Array.isArray(r['episodeIds'])) {
    const ids = r['episodeIds'].filter((v): v is number => typeof v === 'number');
    if (ids.length > 0) out.episodeIds = ids;
  }
  const q = r['quality'];
  if (q && typeof q === 'object') {
    const qq = q as Record<string, unknown>;
    const inner = qq['quality'];
    const id = num(inner && typeof inner === 'object' ? (inner as Record<string, unknown>)['id'] : qq['id']);
    if (id !== undefined) {
      const def = qualityById(id);
      const rev = (qq['revision'] ?? {}) as Record<string, unknown>;
      out.quality = {
        quality: { ...def, mediaTypes: [...def.mediaTypes] },
        revision: {
          version: num(rev['version']) ?? 1,
          real: num(rev['real']) ?? 0,
          isRepack: rev['isRepack'] === true,
        },
      };
    }
  }
  return out;
}
