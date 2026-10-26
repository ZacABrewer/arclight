import type { DelayProfile, QualityModel, QualityProfile, ReleaseProtocol } from '@media-tron/shared';
import { compareQuality, highestAllowedItem, isRevisionUpgrade, itemId } from './quality-profile.js';

/**
 * The delay profile that governs an item with these tags: the lowest `order` among
 * profiles sharing a tag with the item, else the untagged default. Undefined only when
 * no profiles exist at all.
 */
export function selectDelayProfile(profiles: ReadonlyArray<DelayProfile>, tags: ReadonlyArray<number>): DelayProfile | undefined {
  const applicable = profiles.filter((p) => p.tags.length === 0 || p.tags.some((t) => tags.includes(t)));
  return applicable.sort((a, b) => a.order - b.order)[0];
}

export function protocolDelay(profile: DelayProfile, protocol: ReleaseProtocol): number {
  return protocol === 'torrent' ? profile.torrentDelayMinutes : profile.usenetDelayMinutes;
}

export interface DelayCandidate {
  protocol: ReleaseProtocol;
  /** Minutes since the release was published. */
  ageMinutes: number;
  quality: QualityModel;
  formatScore: number;
  /** Quality of the file already in the library, if any. */
  currentQuality?: QualityModel;
}

export type DelayBypass = 'noDelay' | 'revisionUpgrade' | 'highestQuality' | 'formatScore' | 'aged';

export interface DelayDecision {
  /** Minutes this protocol must wait under the profile. */
  delayMinutes: number;
  /** Minutes still to wait; 0 when the release may be grabbed now. */
  remainingMinutes: number;
  /** Why the wait was skipped, when it was. */
  bypass?: DelayBypass;
}

/**
 * How long a release still has to wait. Bypasses apply only on the profile's preferred
 * protocol: a proper/repack of the quality already on disk, a quality at the top of the
 * profile, or a format score at or above the configured minimum all skip the wait.
 */
export function computeDelay(
  delayProfile: DelayProfile,
  qualityProfile: QualityProfile,
  candidate: DelayCandidate,
): DelayDecision {
  const delayMinutes = protocolDelay(delayProfile, candidate.protocol);
  if (delayMinutes === 0) return { delayMinutes, remainingMinutes: 0, bypass: 'noDelay' };

  const preferred = candidate.protocol === delayProfile.preferredProtocol;

  if (preferred && candidate.currentQuality && isRevisionUpgrade(candidate.currentQuality, candidate.quality)) {
    return { delayMinutes, remainingMinutes: 0, bypass: 'revisionUpgrade' };
  }

  if (preferred && delayProfile.bypassIfHighestQuality) {
    const best = highestAllowedItem(qualityProfile);
    if (best && compareQuality(qualityProfile, candidate.quality, itemId(best)) >= 0) {
      return { delayMinutes, remainingMinutes: 0, bypass: 'highestQuality' };
    }
  }

  if (preferred && delayProfile.bypassIfAboveCustomFormatScore && candidate.formatScore >= delayProfile.minimumCustomFormatScore) {
    return { delayMinutes, remainingMinutes: 0, bypass: 'formatScore' };
  }

  const remaining = Math.max(0, delayMinutes - candidate.ageMinutes);
  if (remaining === 0) return { delayMinutes, remainingMinutes: 0, bypass: 'aged' };
  return { delayMinutes, remainingMinutes: remaining };
}

/** Renumber `order` 1..n following the given sequence of ids; untagged default profiles always go last. */
export function reorderDelayProfiles(profiles: ReadonlyArray<DelayProfile>, movingId: number, afterId?: number): DelayProfile[] {
  const sorted = [...profiles].sort((a, b) => a.order - b.order);
  const moving = sorted.find((p) => p.id === movingId);
  if (!moving) return sorted;

  const rest = sorted.filter((p) => p.id !== movingId);
  const afterIdx = afterId === undefined ? -1 : rest.findIndex((p) => p.id === afterId);
  rest.splice(afterIdx + 1, 0, moving);

  const tagged = rest.filter((p) => p.tags.length > 0);
  const untagged = rest.filter((p) => p.tags.length === 0);
  return [...tagged, ...untagged].map((p, i) => ({ ...p, order: i + 1 }));
}
