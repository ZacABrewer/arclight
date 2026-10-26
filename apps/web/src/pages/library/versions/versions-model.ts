import type { MediaVersion, MediaVersions } from '@arclight/shared';
import { t } from '../../../i18n/index.js';

// Multi-version library (docs/API.md "Multi-version library"): the editable draft of a series'
// or movie's `versions`, its validation, and the UpdateSeries/UpdateMovie patch. Pure so the
// rules are unit-tested without rendering.

/** The contract allows at most this many version slots (`MediaVersions.max(8)`). */
export const MAX_VERSIONS = 8;
/** `VersionTag.max(32)`. */
export const MAX_TAG_LENGTH = 32;
/** Characters `VersionTag` refuses (the tag ends up in file and folder names). */
const BAD_TAG_CHARS = /[\/<>:?*|"]/;

export interface VersionDraft {
  /** Stable row key (React key and error map key); not sent. */
  key: number;
  tag: string;
  qualityProfileId: number | null;
  enabled: boolean;
}

let nextKey = 1;

export function toVersionDrafts(versions: readonly MediaVersion[] | null | undefined): VersionDraft[] {
  return (versions ?? []).map((v) => ({ key: nextKey++, tag: v.tag, qualityProfileId: v.qualityProfileId, enabled: v.enabled }));
}

/** Tag suggestions in order; the first one not yet used is offered for a new row. */
const SUGGESTED_TAGS = ['Standard', '4K', 'HDR', 'Remux'];

export function newVersionDraft(existing: readonly VersionDraft[], defaultProfileId: number | null): VersionDraft {
  const used = new Set(existing.map((d) => d.tag.trim().toLowerCase()));
  const tag = SUGGESTED_TAGS.find((s) => !used.has(s.toLowerCase())) ?? '';
  return { key: nextKey++, tag, qualityProfileId: defaultProfileId, enabled: true };
}

/** Per-row problems keyed by `VersionDraft.key`: `{tag?, profile?}`. Empty map = valid. */
export type VersionErrors = Map<number, { tag?: string; profile?: string }>;

export function validateVersions(drafts: readonly VersionDraft[]): VersionErrors {
  const errors: VersionErrors = new Map();
  const seen = new Map<string, number>();
  for (const d of drafts) {
    const tag = d.tag.trim();
    const e: { tag?: string; profile?: string } = {};
    if (tag === '') e.tag = t('library.versions.errorTagRequired');
    else if (tag.length > MAX_TAG_LENGTH) e.tag = t('library.versions.errorTagTooLong', { max: MAX_TAG_LENGTH });
    else if (BAD_TAG_CHARS.test(tag)) e.tag = t('library.versions.errorTagCharacters');
    else if (seen.has(tag.toLowerCase())) e.tag = t('library.versions.errorTagDuplicate');
    if (tag !== '') seen.set(tag.toLowerCase(), d.key);
    if (d.qualityProfileId === null) e.profile = t('library.versions.errorProfileRequired');
    if (e.tag || e.profile) errors.set(d.key, e);
  }
  return errors;
}

/** The contract value: trimmed tags; no rows = null (back to one unversioned file). */
export function toMediaVersions(drafts: readonly VersionDraft[]): MediaVersions | null {
  if (drafts.length === 0) return null;
  return drafts.map((d) => ({ tag: d.tag.trim(), qualityProfileId: d.qualityProfileId ?? 0, enabled: d.enabled }));
}

function normalise(v: readonly MediaVersion[] | null | undefined): string {
  return JSON.stringify((v ?? []).map((x) => [x.tag, x.qualityProfileId, x.enabled]));
}

/**
 * The `versions` part of an UpdateSeriesRequest / UpdateMovieRequest: `{}` when nothing
 * changed (so a plain save never touches versions), else `{versions}` (null clears them).
 */
export function versionsPatch(original: readonly MediaVersion[] | null | undefined, drafts: readonly VersionDraft[]): { versions?: MediaVersions | null } {
  const next = toMediaVersions(drafts);
  return normalise(original) === normalise(next) ? {} : { versions: next };
}

/** Version tags of an item a file can be put into (manual import picker). */
export function versionTags(versions: readonly MediaVersion[] | null | undefined): string[] {
  return (versions ?? []).map((v) => v.tag);
}

/** Mobile wanted rows: " · 4K, HDR" after the date, or nothing for unversioned items. */
export function wantedVersionsSuffix(tags: readonly string[] | undefined): string {
  return tags && tags.length > 0 ? ` · ${tags.join(', ')}` : '';
}

/** True when any row carries a version tag (tables only add a Version column then). */
export function hasVersionTags<T>(rows: readonly T[] | undefined, get: (r: T) => string | null | undefined): boolean {
  return (rows ?? []).some((r) => {
    const tag = get(r);
    return typeof tag === 'string' && tag !== '';
  });
}
