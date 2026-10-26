import type { CustomFormat, MediaFile, QualityProfile } from '@arclight/shared';
import { isCutoffMet, scoreRelease } from '@arclight/profiles-engine';
import { movies, series } from '../../db/schema.js';
import type { IsCutoffMet, LibraryDb } from './service.js';
import { profileIdForSlot, slotOf } from './versions.js';

/** What the cutoff check needs from the profiles module. */
export interface CutoffProfiles {
  listQualityProfiles(): QualityProfile[];
  listCustomFormats(): CustomFormat[];
}

/**
 * The library's cutoff hook: a file meets cutoff when, under its parent's current quality
 * profile, both its quality reaches the profile cutoff and its custom-format score (formats
 * matched against the file's scene name or relative path, quality, languages, size and
 * release group) reaches the format cutoff. A file whose parent or profile is gone counts as
 * met, so it is never searched for blindly.
 *
 * On a versioned item the file is judged against the profile of the version slot it fills.
 *
 * Profiles, formats and each item's profile id are read once when the checker is built; build
 * one per query (or per job run), not per file.
 */
export function createCutoffChecker(db: LibraryDb, profiles: CutoffProfiles): IsCutoffMet {
  const byId = new Map(profiles.listQualityProfiles().map((p) => [p.id, p]));
  const formats = profiles.listCustomFormats();
  const seriesItems = new Map(
    db.select({ id: series.id, qualityProfileId: series.qualityProfileId, versions: series.versions }).from(series).all().map((r) => [r.id, r]),
  );
  const movieItems = new Map(
    db.select({ id: movies.id, qualityProfileId: movies.qualityProfileId, versions: movies.versions }).from(movies).all().map((r) => [r.id, r]),
  );

  return (file: MediaFile) => {
    const item = file.seriesId != null ? seriesItems.get(file.seriesId) : file.movieId != null ? movieItems.get(file.movieId) : undefined;
    const profileId = item ? profileIdForSlot(item, slotOf(file.versionTag ?? null, item.versions)) : undefined;
    const profile = profileId !== undefined ? byId.get(profileId) : undefined;
    if (!profile) return true;
    return isCutoffMet(profile, file.quality, fileFormatScore(profile, formats, file));
  };
}

/** Custom-format score of an existing file under a profile. */
export function fileFormatScore(profile: QualityProfile, formats: readonly CustomFormat[], file: MediaFile): number {
  return scoreRelease(profile, formats, {
    title: file.sceneName ?? file.relativePath,
    quality: file.quality,
    mediaType: file.mediaType,
    languages: file.languages,
    ...(file.releaseGroup ? { releaseGroup: file.releaseGroup } : {}),
    ...(file.edition ? { edition: file.edition } : {}),
    ...(file.sizeBytes ? { sizeBytes: file.sizeBytes } : {}),
  }).score;
}
