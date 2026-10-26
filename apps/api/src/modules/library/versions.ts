import type { MediaVersion, QualityModel, QualityProfile } from '@arclight/shared';
import { effectiveCutoff, isQualityAllowed, qualityIndex } from '@arclight/profiles-engine';

// Multi-version library helpers (pure). An item (series or movie) with a `versions` config
// keeps one file per enabled version slot, each monitored, searched and upgraded against its
// own quality profile. Without a config the item is "unversioned": one file, the item's
// profile, exactly the classic behaviour. A file with no tag on a versioned item belongs to
// the first configured slot, so a library that gains versions later keeps its existing file.

/** The slots that are monitored (enabled); an empty list means the item is unversioned. */
export function enabledVersions(versions: readonly MediaVersion[] | null | undefined): MediaVersion[] {
  return (versions ?? []).filter((v) => v.enabled);
}

export function isVersioned(versions: readonly MediaVersion[] | null | undefined): boolean {
  return (versions ?? []).length > 0;
}

/**
 * The slot a file fills. Tagged files fill their own tag (even if the config no longer lists
 * it); untagged files fill the first configured slot, or `null` on an unversioned item.
 */
export function slotOf(fileTag: string | null | undefined, versions: readonly MediaVersion[] | null | undefined): string | null {
  if (fileTag) return canonicalTag(fileTag, versions);
  const first = (versions ?? [])[0];
  return first ? first.tag : null;
}

/** The configured spelling of a tag (tags compare case-insensitively). */
export function canonicalTag(tag: string, versions: readonly MediaVersion[] | null | undefined): string {
  const hit = (versions ?? []).find((v) => v.tag.toLowerCase() === tag.toLowerCase());
  return hit ? hit.tag : tag;
}

export function sameTag(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.toLowerCase() === b.toLowerCase();
}

export function findVersion(versions: readonly MediaVersion[] | null | undefined, tag: string | null | undefined): MediaVersion | undefined {
  if (!tag) return undefined;
  return (versions ?? []).find((v) => sameTag(v.tag, tag));
}

/** Quality profile governing a slot: the slot's own, else the item's. */
export function profileIdForSlot(
  item: { qualityProfileId: number; versions?: readonly MediaVersion[] | null | undefined },
  tag: string | null | undefined,
): number {
  return findVersion(item.versions, tag)?.qualityProfileId ?? item.qualityProfileId;
}

/** Order of preference for the "primary" file: unversioned first, then config order. */
export function slotRank(tag: string | null | undefined, versions: readonly MediaVersion[] | null | undefined): number {
  if (!tag) return -1;
  const i = (versions ?? []).findIndex((v) => sameTag(v.tag, tag));
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/** Pick the primary file among an item's files (see `slotRank`); undefined for none. */
export function primaryOf<T extends { id: number; versionTag?: string | null | undefined }>(
  files: readonly T[],
  versions: readonly MediaVersion[] | null | undefined,
): T | undefined {
  return [...files].sort((a, b) => slotRank(a.versionTag, versions) - slotRank(b.versionTag, versions) || a.id - b.id)[0];
}

export interface VersionFit {
  version: MediaVersion;
  /** Audio-language fit when the caller passed one (2 = the slot's languages are present, 1 = slot asks none, 0 = missing). */
  languageFit: number;
  /** Whether the version's profile allows the quality at all. */
  allowed: boolean;
  /** Steps between the quality and the profile cutoff (0 = exactly the cutoff). */
  distance: number;
  formatScore: number;
}

/**
 * Pick the enabled version whose profile a release (or file) fits best: a profile that allows
 * the quality beats one that does not; then the one whose cutoff is nearest the quality; then
 * the higher custom-format score; then config order. Returns null for an unversioned item (or
 * one whose versions are all disabled) and when a profile is missing for every slot. When no
 * profile allows the quality the first enabled slot is returned, so the caller's evaluation
 * rejects it with that profile's reason.
 *
 * `languageFit` (optional) ranks first: a slot that asks for audio languages the release has
 * beats a slot that asks for none, which beats one whose languages are missing.
 */
export function pickVersion(
  versions: readonly MediaVersion[] | null | undefined,
  profiles: ReadonlyMap<number, QualityProfile>,
  quality: QualityModel,
  formatScore: (profile: QualityProfile) => number = () => 0,
  languageFit?: (version: MediaVersion) => number,
): MediaVersion | null {
  const fits = rankVersions(versions, profiles, quality, formatScore, languageFit);
  return fits[0]?.version ?? null;
}

export function rankVersions(
  versions: readonly MediaVersion[] | null | undefined,
  profiles: ReadonlyMap<number, QualityProfile>,
  quality: QualityModel,
  formatScore: (profile: QualityProfile) => number = () => 0,
  languageFit?: (version: MediaVersion) => number,
): VersionFit[] {
  const fits: Array<VersionFit & { order: number }> = [];
  enabledVersions(versions).forEach((version, order) => {
    const profile = profiles.get(version.qualityProfileId);
    if (!profile) return;
    const allowed = isQualityAllowed(profile, quality.quality);
    const qi = qualityIndex(profile, quality.quality);
    const ci = qualityIndex(profile, effectiveCutoff(profile));
    const distance = qi >= 0 && ci >= 0 ? Math.abs(ci - qi) : Number.MAX_SAFE_INTEGER;
    fits.push({ version, languageFit: languageFit ? languageFit(version) : 1, allowed, distance, formatScore: formatScore(profile), order });
  });
  fits.sort(
    (a, b) =>
      b.languageFit - a.languageFit ||
      Number(b.allowed) - Number(a.allowed) ||
      a.distance - b.distance ||
      b.formatScore - a.formatScore ||
      a.order - b.order,
  );
  if (fits.length > 0 && !fits[0]!.allowed) {
    // Nothing allows it: evaluate against the first enabled slot (config order), not a random one.
    fits.sort((a, b) => b.languageFit - a.languageFit || a.order - b.order);
  }
  return fits.map(({ order: _o, ...f }) => f);
}

/**
 * Add or update one version slot (requests' 4K track uses this). An unversioned item first
 * gets a slot for what it already has (`baseTag`, the item's current profile) so the existing
 * file keeps a home.
 */
export function upsertVersion(
  item: { qualityProfileId: number; versions?: readonly MediaVersion[] | null | undefined },
  slot: MediaVersion,
  baseTag = DEFAULT_VERSION_TAG,
): MediaVersion[] {
  const current = [...(item.versions ?? [])];
  if (current.length === 0 && !sameTag(baseTag, slot.tag)) {
    current.push({ tag: baseTag, qualityProfileId: item.qualityProfileId, enabled: true });
  }
  const i = current.findIndex((v) => sameTag(v.tag, slot.tag));
  if (i >= 0) {
    current[i] = {
      ...current[i]!,
      qualityProfileId: slot.qualityProfileId,
      enabled: slot.enabled,
      ...(slot.audioLanguages ? { audioLanguages: slot.audioLanguages } : {}),
    };
  }
  else current.push(slot);
  return current;
}

/** Tag given to the pre-existing (non-4K) copy when an unversioned item gains a second version. */
export const DEFAULT_VERSION_TAG = 'Standard';
/** Tag the requests module's 4K track maps to. */
export const UHD_VERSION_TAG = '4K';
