import type { QualityModel, QualityProfile } from '@arclight/shared';
import { compareQuality, compareRevision, isFormatCutoffMet, isQualityAllowed, isQualityCutoffMet } from './quality-profile.js';

// How well an existing library file fits a quality profile. Used when an item moves to a
// different profile, or a profile is edited, to tell files that are fine from files that can
// still be upgraded and files the profile would no longer accept at all.

/** `meets`: nothing to do. `upgradeAllowed`: accepted but below cutoff. `notAllowed`: the profile rejects it. */
export type FileFitStatus = 'meets' | 'upgradeAllowed' | 'notAllowed';

export type FileFitReason = 'qualityNotAllowed' | 'belowMinFormatScore' | 'belowQualityCutoff' | 'belowFormatCutoff';

export interface FileFit {
  status: FileFitStatus;
  /** Every reason that applies, most serious first; empty when the file meets the profile. */
  reasons: FileFitReason[];
}

/**
 * Judge an existing file (its quality and its custom-format score under `profile`):
 * a quality the profile does not allow, or a score below the minimum, is `notAllowed`;
 * otherwise a file below the quality or format cutoff is `upgradeAllowed`; else `meets`.
 */
export function fileFit(profile: QualityProfile, quality: QualityModel, formatScore: number): FileFit {
  const reasons: FileFitReason[] = [];
  if (!isQualityAllowed(profile, quality.quality)) reasons.push('qualityNotAllowed');
  if (formatScore < profile.minFormatScore) reasons.push('belowMinFormatScore');
  if (reasons.length > 0) return { status: 'notAllowed', reasons };
  if (!isQualityCutoffMet(profile, quality.quality)) reasons.push('belowQualityCutoff');
  if (!isFormatCutoffMet(profile, formatScore)) reasons.push('belowFormatCutoff');
  return { status: reasons.length > 0 ? 'upgradeAllowed' : 'meets', reasons };
}

/** True when the profile would not accept this file at all (quality not allowed, or score below minimum). */
export function violatesProfile(profile: QualityProfile, quality: QualityModel, formatScore: number): boolean {
  return !isQualityAllowed(profile, quality.quality) || formatScore < profile.minFormatScore;
}

/**
 * Is `candidate` strictly better than `current` by the profile's own ranking? Higher quality
 * position wins; at equal quality a better revision, then a higher custom-format score. Unlike
 * the upgrade rules this ignores the cutoff: it answers "better", not "wanted".
 */
export function isStrictlyBetter(
  profile: QualityProfile,
  current: { quality: QualityModel; formatScore: number },
  candidate: { quality: QualityModel; formatScore: number },
): boolean {
  const qc = compareQuality(profile, candidate.quality, current.quality);
  if (qc !== 0) return qc > 0;
  const sameQuality = current.quality.quality.id === candidate.quality.quality.id;
  const rc = sameQuality ? compareRevision(candidate.quality.revision, current.quality.revision) : 0;
  if (rc !== 0) return rc > 0;
  return candidate.formatScore > current.formatScore;
}
