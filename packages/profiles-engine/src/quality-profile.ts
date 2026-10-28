import {
  qualityById,
  qualityInDomain,
  type QualityDefinition,
  type QualityModel,
  type QualityProfile,
  type QualityProfileItem,
  type Revision,
} from '@arclight/shared';

export type QualityRef = number | QualityDefinition | QualityModel;

function idOf(ref: QualityRef): number {
  if (typeof ref === 'number') return ref;
  if ('revision' in ref) return ref.quality.id;
  return ref.id;
}

/** Every quality id an item stands for. */
export function itemQualityIds(item: QualityProfileItem): number[] {
  return item.kind === 'quality' ? [item.qualityId] : item.qualityIds;
}

/** The id by which an item can be referenced as a cutoff. */
export function itemId(item: QualityProfileItem): number {
  return item.kind === 'quality' ? item.qualityId : item.id;
}

/**
 * Position of a quality (or group id) in the profile's ordering. Items are ordered
 * worst → best, so a higher index is better. Members of a group share the group's
 * index. -1 when the profile does not list it at all.
 */
export function qualityIndex(profile: QualityProfile, ref: QualityRef): number {
  const id = idOf(ref);
  return profile.items.findIndex((item) => itemId(item) === id || itemQualityIds(item).includes(id));
}

/** The item that holds the given quality or group id, if any. */
export function findItem(profile: QualityProfile, ref: QualityRef): QualityProfileItem | undefined {
  const idx = qualityIndex(profile, ref);
  return idx >= 0 ? profile.items[idx] : undefined;
}

export function isQualityAllowed(profile: QualityProfile, ref: QualityRef): boolean {
  return findItem(profile, ref)?.allowed ?? false;
}

/**
 * Compare two qualities within a profile: negative when `a` ranks below `b`, zero when
 * they are equal (same quality, or members of the same group), positive when `a` is
 * better. Qualities the profile does not list fall back to vocabulary weight, so unknown
 * things still sort somewhere sensible.
 */
export function compareQuality(profile: QualityProfile, a: QualityRef, b: QualityRef): number {
  const ia = qualityIndex(profile, a);
  const ib = qualityIndex(profile, b);
  if (ia >= 0 && ib >= 0) return Math.sign(ia - ib);
  if (ia >= 0) return 1;
  if (ib >= 0) return -1;
  return Math.sign(qualityById(idOf(a)).weight - qualityById(idOf(b)).weight);
}

/** Real > version > repack, in that order of importance. */
export function compareRevision(a: Revision, b: Revision): number {
  if (a.real !== b.real) return Math.sign(a.real - b.real);
  if (a.version !== b.version) return Math.sign(a.version - b.version);
  if (a.isRepack !== b.isRepack) return a.isRepack ? 1 : -1;
  return 0;
}

/**
 * True when `candidate` is the same quality as `current` but a better revision
 * (proper/repack/real). Different qualities never count as revision upgrades.
 */
export function isRevisionUpgrade(current: QualityModel, candidate: QualityModel): boolean {
  return current.quality.id === candidate.quality.id && compareRevision(candidate.revision, current.revision) > 0;
}

export function allowedQualities(profile: QualityProfile): QualityDefinition[] {
  return profile.items.filter((i) => i.allowed).flatMap((i) => itemQualityIds(i).map(qualityById));
}

/** Lowest-ranked allowed item in the profile. */
export function lowestAllowedItem(profile: QualityProfile): QualityProfileItem | undefined {
  return profile.items.find((i) => i.allowed);
}

/** Highest-ranked allowed item in the profile. */
export function highestAllowedItem(profile: QualityProfile): QualityProfileItem | undefined {
  for (let i = profile.items.length - 1; i >= 0; i--) {
    const item = profile.items[i];
    if (item?.allowed) return item;
  }
  return undefined;
}

/** The effective quality cutoff id: the configured one, or the lowest allowed item when upgrades are off. */
export function effectiveCutoff(profile: QualityProfile): number {
  if (profile.upgradeAllowed) return profile.cutoff;
  const lowest = lowestAllowedItem(profile);
  return lowest ? itemId(lowest) : profile.cutoff;
}

export function isQualityCutoffMet(profile: QualityProfile, quality: QualityRef): boolean {
  return compareQuality(profile, quality, effectiveCutoff(profile)) >= 0;
}

export function isFormatCutoffMet(profile: QualityProfile, formatScore: number): boolean {
  const cutoff = profile.upgradeAllowed ? profile.cutoffFormatScore : profile.minFormatScore;
  return formatScore >= cutoff;
}

/**
 * An item is "done" when both its quality reaches the cutoff and its custom format score
 * reaches the format cutoff. Anything below either is still wanted for upgrade.
 */
export function isCutoffMet(profile: QualityProfile, quality: QualityRef, formatScore: number): boolean {
  return isQualityCutoffMet(profile, quality) && isFormatCutoffMet(profile, formatScore);
}

export function isLanguageAllowed(profile: QualityProfile, languages: ReadonlyArray<string>): boolean {
  if (profile.languages.length === 0) return true;
  return languages.some((l) => profile.languages.includes(l));
}

/** What the engine knows about an existing file or a candidate release. */
export interface EvaluatedQuality {
  quality: QualityModel;
  formatScore: number;
}

export type UpgradeRejection =
  | 'betterQuality'
  | 'betterRevision'
  | 'upgradesNotAllowed'
  | 'qualityCutoffMet'
  | 'formatScoreNotHigher'
  | 'formatCutoffMet'
  | 'minUpgradeFormatScore';

export type UpgradeDecision =
  | { upgrade: true; reason: 'quality' | 'revision' | 'formatScore' }
  | { upgrade: false; reason: UpgradeRejection };

/**
 * Should `candidate` replace `current` under this profile? Order of judgement:
 * 1. better quality while the quality cutoff is unmet → yes
 * 2. worse quality → no
 * 3. same quality, better revision (proper/repack/real) → yes, even with upgrades off
 * 4. upgrades disabled → no
 * 5. worse revision → no
 * 6. better quality but cutoff already met → no
 * 7. otherwise decide on custom format score: must be strictly higher, the current
 *    score must be below the format cutoff, and the gain must be ≥ minUpgradeFormatScore.
 */
export function isUpgrade(profile: QualityProfile, current: EvaluatedQuality, candidate: EvaluatedQuality): UpgradeDecision {
  const qualityCmp = compareQuality(profile, candidate.quality, current.quality);

  if (qualityCmp > 0 && !isQualityCutoffMet(profile, current.quality)) return { upgrade: true, reason: 'quality' };
  if (qualityCmp < 0) return { upgrade: false, reason: 'betterQuality' };

  const revisionCmp = compareRevision(candidate.quality.revision, current.quality.revision);
  if (qualityCmp === 0 && isRevisionUpgrade(current.quality, candidate.quality)) {
    return { upgrade: true, reason: 'revision' };
  }

  if (!profile.upgradeAllowed) return { upgrade: false, reason: 'upgradesNotAllowed' };
  if (qualityCmp === 0 && revisionCmp < 0) return { upgrade: false, reason: 'betterRevision' };
  if (qualityCmp > 0) return { upgrade: false, reason: 'qualityCutoffMet' };

  if (candidate.formatScore <= current.formatScore) return { upgrade: false, reason: 'formatScoreNotHigher' };
  if (current.formatScore >= profile.cutoffFormatScore) return { upgrade: false, reason: 'formatCutoffMet' };
  if (candidate.formatScore < current.formatScore + profile.minUpgradeFormatScore) {
    return { upgrade: false, reason: 'minUpgradeFormatScore' };
  }
  return { upgrade: true, reason: 'formatScore' };
}

export type ProfileValidationIssue = { path: string; message: string };

/** Structural checks a profile must pass before it can be saved or evaluated against. */
export function validateQualityProfile(profile: Omit<QualityProfile, 'id'>): ProfileValidationIssue[] {
  const issues: ProfileValidationIssue[] = [];
  const seenQualities = new Set<number>();
  const seenIds = new Set<number>();
  const domain = profile.mediaDomain ?? 'video';

  profile.items.forEach((item, i) => {
    const id = itemId(item);
    if (seenIds.has(id)) issues.push({ path: `items[${i}]`, message: `duplicate item id ${id}` });
    seenIds.add(id);
    for (const q of itemQualityIds(item)) {
      if (qualityById(q).id !== q) issues.push({ path: `items[${i}]`, message: `unknown quality id ${q}` });
      else if (!qualityInDomain(q, domain)) issues.push({ path: `items[${i}]`, message: `quality ${q} is not a ${domain} quality` });
      if (seenQualities.has(q)) issues.push({ path: `items[${i}]`, message: `quality ${q} listed more than once` });
      seenQualities.add(q);
    }
  });

  if (!profile.items.some((i) => i.allowed)) issues.push({ path: 'items', message: 'at least one quality must be allowed' });

  const cutoffItem = profile.items.find((i) => itemId(i) === profile.cutoff);
  if (!cutoffItem) issues.push({ path: 'cutoff', message: 'cutoff must be one of the profile items' });
  else if (!cutoffItem.allowed) issues.push({ path: 'cutoff', message: 'cutoff must be an allowed item' });

  const formatIds = new Set<number>();
  profile.formatItems.forEach((f, i) => {
    if (formatIds.has(f.formatId)) issues.push({ path: `formatItems[${i}]`, message: `format ${f.formatId} scored twice` });
    formatIds.add(f.formatId);
  });

  return issues;
}
