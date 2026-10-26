import {
  QUALITY_GROUP_ID_BASE,
  qualityById,
  type DelayProfile,
  type DelayProfileReorderRequest,
  type ProfileFormatItem,
  type QualityProfileInput,
  type QualityProfileItem,
} from '@media-tron/shared';

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
  if (!p.name.trim()) errors.name = 'Name is required';
  if (!p.items.some((i) => i.allowed)) errors.items = 'Allow at least one quality';
  else if (!cutoffOptions(p.items).some((o) => o.value === p.cutoff)) {
    errors.cutoff = 'The cutoff must be one of the allowed qualities';
  }
  if (p.upgradeAllowed && p.minUpgradeFormatScore < 1) errors.minUpgradeFormatScore = 'Must be at least 1';
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
