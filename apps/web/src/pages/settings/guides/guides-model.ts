import type { ChipTone } from '../../../arclight/index.js';
import { TRASH_GUIDES_REPO_URL, type GuideApp, type GuidesDiffItem, type GuidesProfileMapping, type GuidesSettings } from '@arclight/shared';
import { t } from '../../../i18n/index.js';

// Pure helpers for Settings → Guides (kept apart from the page so they are easy to test).

export const KIND_LABELS: Record<GuidesDiffItem['kind'], string> = {
  get createFormat() {
    return t('settings.guides.newFormat');
  },
  get updateFormat() {
    return t('settings.guides.formatChanged');
  },
  get adoptFormat() {
    return t('settings.guides.adoptFormat');
  },
  get setScore() {
    return t('common.score');
  },
};

export const KIND_TONES: Record<GuidesDiffItem['kind'], ChipTone> = {
  createFormat: 'accent',
  updateFormat: 'default',
  adoptFormat: 'warn',
  setScore: 'neutral',
};

/** Display order of the diff groups. */
export const KIND_ORDER: readonly GuidesDiffItem['kind'][] = ['createFormat', 'updateFormat', 'adoptFormat', 'setScore'];

export const APP_LABELS: Record<GuideApp, string> = { get radarr() { return t('settings.guides.moviesRadarr'); }, get sonarr() { return t('settings.guides.seriesSonarr'); } };

/** Title of one diff row: the format name, or "<format> on <profile>" for a score. */
export function diffItemTitle(item: GuidesDiffItem): string {
  return item.kind === 'setScore' ? t('settings.guides.formatnameOnProfilename', { formatName: item.formatName, profileName: item.profileName }) : item.name;
}

/** Mono detail of one diff row: "0 → 1500", "unset → -10000", "3 specs", … */
export function diffItemDetail(item: GuidesDiffItem): string {
  if (item.kind === 'setScore') return `${item.before === null ? t('settings.guides.unset') : item.before} → ${item.after}`;
  const specs = item.after.specifications.length;
  const base = t('settings.guides.specCount', { count: specs });
  if (item.kind === 'createFormat') return base;
  const before = item.before?.specifications.length;
  return before === undefined || before === specs ? base : t('settings.guides.specChange', { before, after: specs });
}

/** Diff items grouped by kind in display order; empty groups dropped. */
export function groupDiff(items: readonly GuidesDiffItem[]): Array<{ kind: GuidesDiffItem['kind']; items: GuidesDiffItem[] }> {
  return KIND_ORDER.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length > 0);
}

/** Ids "Apply all" covers (the api skips adoptFormat without explicit ids). */
export function applyAllIds(items: readonly GuidesDiffItem[]): string[] {
  return items.filter((i) => i.kind !== 'adoptFormat').map((i) => i.id);
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The local profile id a guide profile is mapped to in a draft, or null. */
export function mappingFor(profiles: readonly GuidesProfileMapping[], name: string, app: GuideApp): number | null {
  const hit = profiles.find((p) => sameName(p.guideProfileName, name) && (p.app === undefined || p.app === app));
  return hit ? hit.localQualityProfileId : null;
}

/** Map (or with null, unmap) a guide profile. One mapping per guide profile name + app. */
export function setMapping(profiles: readonly GuidesProfileMapping[], name: string, app: GuideApp, localId: number | null): GuidesProfileMapping[] {
  const rest = profiles.filter((p) => !(sameName(p.guideProfileName, name) && (p.app === undefined || p.app === app)));
  return localId === null ? rest : [...rest, { guideProfileName: name, localQualityProfileId: localId, app }];
}

export type GuidesErrors = Partial<Record<'repoUrl' | 'branch' | 'apps' | 'syncIntervalHours', string>>;

export function validateGuides(v: GuidesSettings): GuidesErrors {
  const errors: GuidesErrors = {};
  if (v.source === 'custom') {
    try {
      const u = new URL(v.repoUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.repoUrl = t('settings.guides.useAnHttpSUrl');
    } catch {
      errors.repoUrl = t('settings.guides.enterFullRepoUrl');
    }
  }
  if (!v.branch.trim()) errors.branch = t('settings.guides.enterABranch');
  if (v.apps.length === 0) errors.apps = t('settings.guides.pickAtLeastOne');
  const h = v.syncIntervalHours;
  if (!Number.isInteger(h) || h < 1 || h > 168) errors.syncIntervalHours = t('settings.guides.use1To168Hours');
  return errors;
}

/** Repository line for the status pane. */
export function repoLabel(source: GuidesSettings['source'], repoUrl: string, branch: string): string {
  return `${source === 'trash' ? TRASH_GUIDES_REPO_URL : repoUrl}${branch}`;
}
