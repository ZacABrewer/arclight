import { createHash } from 'node:crypto';
import {
  CustomFormatInput,
  type CustomFormat,
  type GuideApp,
  type GuidesDiff,
  type GuidesDiffItem,
  type GuidesSettings,
  type QualityProfile,
} from '@arclight/shared';
import { scoreFor, type GuideFormat, type GuideProfile } from './parse.js';

// The pure part of a sync: which guide formats are wanted, what the local database looks
// like, and the change set between them. Nothing here touches the database or the network.

export interface GuideData {
  formats: GuideFormat[];
  profiles: GuideProfile[];
  warnings: string[];
}

export type LocalFormat = CustomFormat & { guideId: string | null };

export interface LocalState {
  formats: LocalFormat[];
  profiles: QualityProfile[];
}

export interface ResolvedMapping {
  guide: GuideProfile;
  local: QualityProfile;
}

/** Case-insensitive glob (`*`, `?`) match. */
export function matchesPattern(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern
      .trim()
      .split('')
      .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
    'i',
  );
  return re.test(value);
}

function matchesAny(patterns: readonly string[], f: Pick<GuideFormat, 'name' | 'guideId'>): boolean {
  return patterns.some((p) => matchesPattern(p, f.name) || matchesPattern(p, f.guideId));
}

/** Map settings.profiles onto guide profiles and local quality profiles. */
export function resolveMappings(
  guide: Pick<GuideData, 'profiles'>,
  local: Pick<LocalState, 'profiles'>,
  settings: Pick<GuidesSettings, 'profiles' | 'apps'>,
): { mappings: ResolvedMapping[]; warnings: string[] } {
  const mappings: ResolvedMapping[] = [];
  const warnings: string[] = [];
  for (const m of settings.profiles) {
    const apps: readonly GuideApp[] = m.app ? [m.app] : settings.apps;
    let found: GuideProfile | undefined;
    for (const app of apps) {
      found = guide.profiles.find((p) => p.app === app && p.name.toLowerCase() === m.guideProfileName.toLowerCase());
      if (found) break;
    }
    const localProfile = local.profiles.find((p) => p.id === m.localQualityProfileId);
    if (!found) warnings.push(`guide profile "${m.guideProfileName}" not found${m.app ? ` in ${m.app}` : ''}`);
    if (!localProfile) warnings.push(`quality profile ${m.localQualityProfileId} (mapped to "${m.guideProfileName}") does not exist`);
    if (found && localProfile) mappings.push({ guide: found, local: localProfile });
  }
  return { mappings, warnings };
}

/**
 * Guide formats to sync: referenced by a mapped profile or matching `includeFormats`, minus
 * `excludeFormats`. Duplicate guide ids keep the first; the local name gets an app suffix
 * when another selected format already uses it.
 */
export function selectFormats(
  guide: Pick<GuideData, 'formats'>,
  mappings: readonly ResolvedMapping[],
  settings: Pick<GuidesSettings, 'apps' | 'includeFormats' | 'excludeFormats'>,
): Array<GuideFormat & { localName: string }> {
  const referenced = new Set(mappings.flatMap((m) => m.guide.formatItems.map((f) => `${m.guide.app}:${f.guideId}`)));
  const appOrder = (app: GuideApp) => settings.apps.indexOf(app);
  const candidates = guide.formats
    .filter((f) => settings.apps.includes(f.app))
    .filter((f) => referenced.has(`${f.app}:${f.guideId}`) || matchesAny(settings.includeFormats, f))
    .filter((f) => !matchesAny(settings.excludeFormats, f))
    .sort((a, b) => appOrder(a.app) - appOrder(b.app) || a.name.localeCompare(b.name));
  const seenIds = new Set<string>();
  const usedNames = new Set<string>();
  const out: Array<GuideFormat & { localName: string }> = [];
  for (const f of candidates) {
    if (seenIds.has(f.guideId)) continue;
    seenIds.add(f.guideId);
    let localName = f.name;
    if (usedNames.has(localName.toLowerCase())) localName = `${f.name} (${f.app === 'radarr' ? 'Radarr' : 'Sonarr'})`;
    usedNames.add(localName.toLowerCase());
    out.push({ ...f, localName });
  }
  return out;
}

/** Canonical form of a format for comparison (schema defaults applied, stable key order). */
export function canonicalFormat(f: CustomFormatInput): string {
  const p = CustomFormatInput.parse({ name: f.name, includeWhenRenaming: f.includeWhenRenaming, specifications: f.specifications });
  return stableStringify(p);
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function toInput(f: LocalFormat): CustomFormatInput {
  return { name: f.name, includeWhenRenaming: f.includeWhenRenaming, specifications: f.specifications };
}

export function revisionOf(items: readonly GuidesDiffItem[]): string {
  return createHash('sha256').update(stableStringify(items)).digest('hex').slice(0, 16);
}

/** The change set between the guide and the local database. */
export function buildDiff(guide: GuideData, local: LocalState, settings: GuidesSettings, now: Date = new Date()): GuidesDiff {
  const warnings = [...guide.warnings];
  const { mappings, warnings: mappingWarnings } = resolveMappings(guide, local, settings);
  warnings.push(...mappingWarnings);
  const selected = selectFormats(guide, mappings, settings);
  const published = new Set(guide.formats.map((f) => `${f.app}:${f.guideId}`));
  for (const m of mappings) {
    const missing = m.guide.formatItems.filter((f) => !published.has(`${m.guide.app}:${f.guideId}`));
    if (missing.length) warnings.push(`guide profile "${m.guide.name}" lists ${missing.length} format(s) the guide does not publish: ${missing.map((f) => f.name).join(', ')}`);
  }

  const byGuideId = new Map(local.formats.filter((f) => f.guideId).map((f) => [f.guideId!, f]));
  const byName = new Map(local.formats.map((f) => [f.name.toLowerCase(), f]));
  const formatItems: GuidesDiffItem[] = [];

  for (const g of selected) {
    const after: CustomFormatInput = { ...g.input, name: g.localName };
    const id = `format:${g.guideId}`;
    const base = { id, guideId: g.guideId, app: g.app, name: g.localName, after, warnings: g.warnings };
    const existing = byGuideId.get(g.guideId);
    const holder = byName.get(g.localName.toLowerCase());
    if (existing) {
      if (holder && holder.id !== existing.id) {
        warnings.push(`"${g.localName}" was renamed upstream but that name is taken by format ${holder.id}; not updated`);
        continue;
      }
      if (canonicalFormat(toInput(existing)) !== canonicalFormat(after)) {
        formatItems.push({ kind: 'updateFormat', ...base, formatId: existing.id, before: toInput(existing) });
      }
      continue;
    }
    if (holder) {
      if (holder.guideId === null) {
        formatItems.push({ kind: 'adoptFormat', ...base, formatId: holder.id, before: toInput(holder) });
      } else {
        warnings.push(`"${g.localName}" is already used by a format synced from guide id ${holder.guideId}; skipped`);
      }
      continue;
    }
    formatItems.push({ kind: 'createFormat', ...base, formatId: null, before: null });
  }

  // Scores on mapped profiles. A later mapping to the same local profile overrides an earlier one.
  const selectedById = new Map(selected.map((f) => [f.guideId, f]));
  const scores = new Map<string, Extract<GuidesDiffItem, { kind: 'setScore' }>>();
  const seenProfiles = new Set<number>();
  for (const { guide: gp, local: lp } of mappings) {
    if (seenProfiles.has(lp.id)) warnings.push(`quality profile "${lp.name}" is mapped more than once; the last mapping wins`);
    seenProfiles.add(lp.id);
    const wanted = new Set(gp.formatItems.map((f) => f.guideId).filter((id) => selectedById.has(id)));
    if (settings.scoreAllSyncedFormats) for (const id of selectedById.keys()) wanted.add(id);
    for (const guideId of wanted) {
      const g = selectedById.get(guideId)!;
      const after = scoreFor(g, gp.scoreSet);
      if (after === undefined) continue;
      const localFormat = byGuideId.get(guideId);
      const before = localFormat ? (lp.formatItems.find((i) => i.formatId === localFormat.id)?.score ?? null) : null;
      if (after === (before ?? 0)) continue;
      const id = `score:${lp.id}:${guideId}`;
      scores.set(id, {
        id,
        kind: 'setScore',
        guideId,
        app: g.app,
        profileId: lp.id,
        profileName: lp.name,
        guideProfileName: gp.name,
        formatName: g.localName,
        formatId: localFormat?.id ?? null,
        before,
        after,
      });
    }
  }
  const scoreItems = [...scores.values()].sort((a, b) => a.profileId - b.profileId || a.formatName.localeCompare(b.formatName));

  const allGuideIds = new Set(guide.formats.map((f) => f.guideId));
  const staleFormats = local.formats
    .filter((f) => f.guideId !== null && !allGuideIds.has(f.guideId))
    .map((f) => ({ formatId: f.id, name: f.name, guideId: f.guideId! }));

  formatItems.sort((a, b) => (a.kind === 'setScore' || b.kind === 'setScore' ? 0 : a.name.localeCompare(b.name)));
  const items = [...formatItems, ...scoreItems];
  return { generatedAt: now.toISOString(), revision: revisionOf(items), items, staleFormats, warnings };
}
