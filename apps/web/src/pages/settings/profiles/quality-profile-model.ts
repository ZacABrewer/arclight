import {
  QUALITY_GROUP_ID_BASE,
  qualitiesForDomain,
  qualityById,
  qualityInDomain,
  type CustomFormat,
  type MediaDomain,
  type DelayProfile,
  type DelayProfileReorderRequest,
  type ProfileFormatItem,
  type QualityProfileInput,
  type QualityProfileItem,
} from '@arclight/shared';
import { customFormatFitsDomain } from '../../../lib/custom-format-domain.js';
import { t } from '../../../i18n/index.js';

// Pure editing logic for the quality-profile dialog. The api stores items worst -> best; the
// editor shows best first (like every *arr), so the dialog converts with toDisplay/fromDisplay
// and every helper here works on whatever order it is given.

export function itemId(item: QualityProfileItem): number {
  return item.kind === 'quality' ? item.qualityId : item.id;
}

export function itemName(item: QualityProfileItem): string {
  return item.kind === 'quality' ? qualityById(item.qualityId).name : item.name;
}

export function toDisplay(items: readonly QualityProfileItem[]): QualityProfileItem[] {
  return [...items].reverse();
}

export const fromDisplay = toDisplay;

/** Move one entry; out-of-range targets are clamped. Returns a new array. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const target = Math.max(0, Math.min(list.length - 1, to));
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved as T);
  return next;
}

export function setAllowed(list: readonly QualityProfileItem[], index: number, allowed: boolean): QualityProfileItem[] {
  return list.map((item, i) => (i === index ? { ...item, allowed } : item));
}

function nextGroupId(list: readonly QualityProfileItem[]): number {
  const ids = list.filter((i) => i.kind === 'group').map((i) => itemId(i));
  return ids.length ? Math.max(...ids) + 1 : QUALITY_GROUP_ID_BASE;
}

/**
 * Merge the entries at `indices` into one group placed where the first of them was. Existing
 * groups among the selection are flattened into the new one. Needs at least two qualities.
 */
export function groupItems(list: readonly QualityProfileItem[], indices: readonly number[], name: string): QualityProfileItem[] {
  const picked = [...new Set(indices)].filter((i) => i >= 0 && i < list.length).sort((a, b) => a - b);
  const qualityIds = picked.flatMap((i) => {
    const item = list[i]!;
    return item.kind === 'quality' ? [item.qualityId] : item.qualityIds;
  });
  if (qualityIds.length < 2 || !name.trim()) return [...list];
  const group: QualityProfileItem = {
    kind: 'group',
    id: nextGroupId(list),
    name: name.trim(),
    qualityIds,
    allowed: picked.some((i) => list[i]!.allowed),
  };
  const out: QualityProfileItem[] = [];
  list.forEach((item, i) => {
    if (i === picked[0]) out.push(group);
    else if (!picked.includes(i)) out.push(item);
  });
  return out;
}

/** Replace a group with its member qualities (inheriting its allowed flag), in place. */
export function ungroupItem(list: readonly QualityProfileItem[], index: number): QualityProfileItem[] {
  const item = list[index];
  if (!item || item.kind !== 'group') return [...list];
  const members: QualityProfileItem[] = item.qualityIds.map((qualityId) => ({ kind: 'quality', qualityId, allowed: item.allowed }));
  return [...list.slice(0, index), ...members, ...list.slice(index + 1)];
}

/** Cutoff candidates: allowed entries only, in the order given. */
export function cutoffOptions(items: readonly QualityProfileItem[]): Array<{ value: number; label: string }> {
  return items.filter((i) => i.allowed).map((i) => ({ value: itemId(i), label: itemName(i) }));
}

export interface ProfileErrors {
  name?: string;
  items?: string;
  cutoff?: string;
  minUpgradeFormatScore?: string;
}

export function validateProfile(p: QualityProfileInput): ProfileErrors {
  const errors: ProfileErrors = {};
  if (!p.name.trim()) errors.name = t('common.nameIsRequired');
  if (!p.items.some((i) => i.allowed)) errors.items = t('settings.profiles.qualityProfile.allowAtLeastOneQuality');
  else if (!cutoffOptions(p.items).some((o) => o.value === p.cutoff)) {
    errors.cutoff = t('settings.profiles.qualityProfile.theCutoffMustBeOne');
  }
  if (p.upgradeAllowed && p.minUpgradeFormatScore < 1) errors.minUpgradeFormatScore = t('settings.profiles.qualityProfile.mustBeAtLeast1');
  return errors;
}

/** Set a custom format's score; a score of 0 removes the entry. */
export function setFormatScore(items: readonly ProfileFormatItem[], formatId: number, score: number): ProfileFormatItem[] {
  const rest = items.filter((i) => i.formatId !== formatId);
  return score === 0 || Number.isNaN(score) ? rest : [...rest, { formatId, score }];
}

export function formatScore(items: readonly ProfileFormatItem[], formatId: number): number {
  return items.find((i) => i.formatId === formatId)?.score ?? 0;
}

// ---- delay profiles ---------------------------------------------------------------------

export function isDefaultDelayProfile(p: Pick<DelayProfile, 'tags'>): boolean {
  return p.tags.length === 0;
}

/**
 * Reorder request for moving the profile at `index` one step up or down in `sorted` (by
 * `order`). Returns null when the move is not allowed: the default profile is pinned last and
 * nothing may move below it.
 */
export function delayReorderRequest(
  sorted: readonly DelayProfile[],
  index: number,
  direction: 'up' | 'down',
): DelayProfileReorderRequest | null {
  const item = sorted[index];
  if (!item || isDefaultDelayProfile(item)) return null;
  if (direction === 'up') {
    if (index === 0) return null;
    const before = sorted[index - 2];
    return before ? { id: item.id, afterId: before.id } : { id: item.id };
  }
  const below = sorted[index + 1];
  if (!below || isDefaultDelayProfile(below)) return null;
  return { id: item.id, afterId: below.id };
}

/**
 * Reorder request for dragging the profile at `from` onto the row at `to` (indices into
 * `sorted`). The dragged profile takes the target's place. Null when nothing changes or the
 * move would touch the default profile, which stays pinned last.
 */
export function delayDropRequest(sorted: readonly DelayProfile[], from: number, to: number): DelayProfileReorderRequest | null {
  const item = sorted[from];
  const target = sorted[to];
  if (!item || !target || from === to || isDefaultDelayProfile(item) || isDefaultDelayProfile(target)) return null;
  if (to > from) return { id: item.id, afterId: target.id };
  const before = sorted[to - 1];
  return before ? { id: item.id, afterId: before.id } : { id: item.id };
}

// ---- media domains ----------------------------------------------------------------------

/** A profile's domain; profiles from before audio have none and are video. */
export function profileDomain(p: { mediaDomain?: MediaDomain | undefined }): MediaDomain {
  return p.mediaDomain ?? 'video';
}

export const DOMAIN_ORDER: readonly MediaDomain[] = ['video', 'music', 'audiobook'];

export function domainLabel(d: MediaDomain | 'any'): string {
  switch (d) {
    case 'video':
      return t('settings.profiles.domain.video');
    case 'music':
      return t('common.music');
    case 'audiobook':
      return t('settings.profiles.domain.audiobook');
    default:
      return t('settings.profiles.domain.any');
  }
}

/** Every quality of the domain (Unknown left out), stored order worst -> best, none allowed. */
export function domainItems(domain: MediaDomain): QualityProfileItem[] {
  return [...qualitiesForDomain(domain)]
    .filter((q) => q.id !== 0)
    .sort((a, b) => a.weight - b.weight)
    .map((q) => ({ kind: 'quality' as const, qualityId: q.id, allowed: false }));
}

/** Only the entries of `domain` (a group stays when every member belongs to it). */
export function itemsInDomain(items: readonly QualityProfileItem[], domain: MediaDomain): QualityProfileItem[] {
  return items.filter((i) => (i.kind === 'quality' ? qualityInDomain(i.qualityId, domain) : i.qualityIds.every((q) => qualityInDomain(q, domain))));
}

/** The formats a profile of `domain` may score. */
export function formatsForDomain<T extends Pick<CustomFormat, 'specifications'>>(formats: readonly T[], domain: MediaDomain): T[] {
  return formats.filter((f) => customFormatFitsDomain(f, domain));
}

/**
 * A draft moved to another domain: that domain's qualities (best first, none allowed), no
 * cutoff, and only the format scores whose formats fit the new domain.
 */
export function switchDomain(
  draft: QualityProfileInput,
  domain: MediaDomain,
  formats: readonly Pick<CustomFormat, 'id' | 'specifications'>[],
): QualityProfileInput {
  const fits = new Set(formatsForDomain(formats, domain).map((f) => f.id));
  return {
    ...draft,
    mediaDomain: domain,
    items: toDisplay(domainItems(domain)),
    cutoff: 0,
    formatItems: draft.formatItems.filter((i) => fits.has(i.formatId)),
    // Languages describe video audio tracks; audio profiles do not use them.
    languages: domain === 'video' ? draft.languages : [],
  };
}

/** Profiles grouped by domain in DOMAIN_ORDER (empty domains left out). */
export function groupByDomain<T extends { mediaDomain?: MediaDomain | undefined }>(profiles: readonly T[]): Array<{ domain: MediaDomain; profiles: T[] }> {
  return DOMAIN_ORDER.map((domain) => ({ domain, profiles: profiles.filter((p) => profileDomain(p) === domain) })).filter((g) => g.profiles.length > 0);
}
