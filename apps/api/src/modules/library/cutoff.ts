import type { CustomFormat, MediaFile, QualityProfile } from '@arclight/shared';
import { isCutoffMet, scoreRelease } from '@arclight/profiles-engine';
import { additionalLanguages, movies, series } from '../../db/schema.js';
import { fileAudioLanguages, missingLanguages, requiredAudioFor } from '../additional-languages/audio.js';
import type { IsCutoffMet, LibraryDb } from './service.js';
import { findVersion, profileIdForSlot, slotOf } from './versions.js';

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
 * A file that lacks an audio language its item requires ("Add additional…" → audio) does not
 * meet cutoff either, so the cutoff-unmet search keeps looking for a release that has it.
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

  const audioRows = db.select().from(additionalLanguages).all().filter((r) => r.kind === 'audio');

  return (file: MediaFile) => {
    const item = file.seriesId != null ? seriesItems.get(file.seriesId) : file.movieId != null ? movieItems.get(file.movieId) : undefined;
    const slot = item ? slotOf(file.versionTag ?? null, item.versions) : null;
    const profileId = item ? profileIdForSlot(item, slot) : undefined;
    const profile = profileId !== undefined ? byId.get(profileId) : undefined;
    if (!profile) return true;
    if (item && audioRows.length > 0 && lacksRequiredAudio(audioRows, file, findVersion(item.versions, slot))) return false;
    return isCutoffMet(profile, file.quality, fileFormatScore(profile, formats, file));
  };
}

function lacksRequiredAudio(
  rows: Parameters<typeof requiredAudioFor>[0],
  file: MediaFile,
  slot: Parameters<typeof requiredAudioFor>[2],
): boolean {
  const required = requiredAudioFor(
    rows,
    {
      movieId: file.movieId ?? null,
      seriesId: file.seriesId ?? null,
      episodes: file.episodeIds.map((id) => ({ id, seasonNumber: file.seasonNumber ?? -1 })),
    },
    slot,
  );
  if (!required) return false;
  const have = fileAudioLanguages(file, { fallback: true });
  return have !== null && missingLanguages(required.languages, have).length > 0;
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
