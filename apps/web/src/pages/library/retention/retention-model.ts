import type {
  RetentionAction,
  RetentionCandidate,
  RetentionCandidateStatus,
  RetentionCondition,
  RetentionRule,
  RetentionRuleInput,
  RetentionScope,
  Tag,
} from '@arclight/shared';
import type { ChipTone } from '../../../arclight/index.js';
import { formatBytes } from '../../../components/media/format.js';
import { t } from '../../../i18n/index.js';

// Pure helpers for Library → Retention: labels, defaults, validation and the summary cards.

export type ConditionType = RetentionCondition['type'];

export const CONDITION_OPTIONS: ReadonlyArray<{ value: ConditionType; label: string }> = [
  { value: 'watchedByAll', get label() { return t('library.retention.watchedByEveryUser'); } },
  { value: 'watchedByAny', get label() { return t('library.retention.watchedByAnyUser'); } },
  { value: 'watchedByUsers', get label() { return t('library.retention.watchedByTheseUsers'); } },
  { value: 'addedOlderThanDays', get label() { return t('library.retention.addedMoreThanNDays'); } },
  { value: 'notWatchedWithinDays', get label() { return t('library.retention.notWatchedInNDays'); } },
  { value: 'sizeAbove', get label() { return t('library.retention.largerThan'); } },
];

export const ACTION_OPTIONS: ReadonlyArray<{ value: RetentionAction; label: string }> = [
  { value: 'unmonitor', get label() { return t('common.unmonitor'); } },
  { value: 'deleteFiles', get label() { return t('library.retention.deleteFiles'); } },
  { value: 'deleteItem', get label() { return t('library.retention.deleteFromLibrary'); } },
];

export const GIB = 1024 ** 3;

export function actionLabel(action: RetentionAction): string {
  return ACTION_OPTIONS.find((a) => a.value === action)?.label ?? action;
}

/** A fresh condition of a kind, with sensible numbers. */
export function defaultCondition(type: ConditionType): RetentionCondition {
  switch (type) {
    case 'watchedByAll':
      return { type };
    case 'watchedByAny':
      return { type };
    case 'watchedByUsers':
      return { type, users: [] };
    case 'addedOlderThanDays':
      return { type, days: 90 };
    case 'notWatchedWithinDays':
      return { type, days: 180 };
    case 'sizeAbove':
      return { type, bytes: 50 * GIB };
  }
}

/** "Watched by every user", "Added more than 90 days ago", "Larger than 50 GB". */
export function conditionLabel(c: RetentionCondition): string {
  switch (c.type) {
    case 'watchedByAll':
      return t('library.retention.watchedByEveryUser');
    case 'watchedByAny':
      return t('library.retention.watchedByAnyUser');
    case 'watchedByUsers':
      return c.users.length ? t('library.retention.watchedByUsers', { users: c.users.join(', ') }) : t('library.retention.watchedByNoUsersChosen');
    case 'addedOlderThanDays':
      return t('library.retention.addedMoreThanDaysAgo', { days: c.days });
    case 'notWatchedWithinDays':
      return t('library.retention.notWatchedInDays', { days: c.days });
    case 'sizeAbove':
      return t('library.retention.largerThanBytes', { bytes: formatBytes(c.bytes) });
  }
}

export function scopeLabel(scope: RetentionScope, tags: readonly Pick<Tag, 'id' | 'label'>[] = []): string {
  if (scope.type === 'all') return t('library.retention.wholeLibrary');
  if (scope.type === 'tags') {
    const names = scope.tagIds.map((id) => tags.find((pick) => pick.id === id)?.label ?? `#${id}`);
    return t('library.retention.tagsNames', { names: names.join(', ') });
  }
  return t('library.retention.rootFoldersPaths', { paths: scope.paths.join(', ') });
}

export function emptyRule(): RetentionRuleInput {
  return {
    name: '',
    enabled: true,
    mediaType: 'movie',
    scope: { type: 'all' },
    conditions: [{ type: 'watchedByAll' }],
    graceDays: 7,
    action: 'unmonitor',
    addExclusion: false,
    keepIfRequestedWithinDays: null,
    keepIfInCollection: false,
    dryRun: true,
  };
}

/** The editable part of a saved rule. */
export function ruleToInput(rule: RetentionRule): RetentionRuleInput {
  const { id: _id, createdAt: _c, updatedAt: _u, ...input } = rule;
  return input;
}

/** What the api would reject, in plain words. Empty = ready to save. */
export function validateRule(input: RetentionRuleInput, existingNames: readonly string[] = []): string[] {
  const errors: string[] = [];
  const name = input.name.trim();
  if (!name) errors.push(t('library.retention.nameTheRule'));
  else if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) errors.push(t('library.retention.aRuleNamedNameAlready', { name }));
  if (input.conditions.length === 0) errors.push(t('library.retention.addAtLeastOneCondition'));
  for (const c of input.conditions) {
    if (c.type === 'watchedByUsers' && c.users.length === 0) errors.push(t('library.retention.nameAtLeastOneUser'));
    if ((c.type === 'addedOlderThanDays' || c.type === 'notWatchedWithinDays' || c.type === 'sizeAbove') && !Number.isFinite(c.type === 'sizeAbove' ? c.bytes : c.days)) {
      errors.push(t('library.retention.conditionlabelNeedsANumber', { conditionLabel: conditionLabel(c) }));
    }
    if (c.type === 'notWatchedWithinDays' && c.days < 1) errors.push(t('library.retention.notWatchedInNDays2'));
  }
  if (input.scope.type === 'tags' && input.scope.tagIds.length === 0) errors.push(t('library.retention.pickAtLeastOneTag'));
  if (input.scope.type === 'rootFolders' && input.scope.paths.length === 0) errors.push(t('library.retention.pickAtLeastOneRoot'));
  if (input.graceDays < 0 || input.graceDays > 3650) errors.push(t('library.retention.gracePeriodIs0To'));
  return errors;
}

/** Strip fields the action or media type does not use before saving. */
export function normaliseRule(input: RetentionRuleInput): RetentionRuleInput {
  return {
    ...input,
    name: input.name.trim(),
    addExclusion: input.action === 'deleteItem' ? input.addExclusion : false,
    keepIfInCollection: input.mediaType === 'movie' ? input.keepIfInCollection : false,
  };
}

const STATUS: Record<RetentionCandidateStatus, { label: string; tone: ChipTone }> = {
  pending: { get label() { return t('library.retention.waiting'); }, tone: 'default' },
  kept: { get label() { return t('library.retention.kept'); }, tone: 'neutral' },
  applied: { get label() { return t('common.applied'); }, tone: 'accent' },
  failed: { get label() { return t('status.failed'); }, tone: 'danger' },
};

/** Chip for a candidate; failures say why, dry runs say they will not apply on their own. */
export function candidateStatus(c: Pick<RetentionCandidate, 'status' | 'error' | 'dryRun'>): { label: string; tone: ChipTone } {
  const s = STATUS[c.status];
  if (c.status === 'failed') return { label: t('library.retention.failedValue', { value: c.error?.trim() || 'no reason given' }), tone: 'danger' };
  if (c.status === 'pending' && c.dryRun) return { label: t('common.dryRun'), tone: 'muted' };
  return s;
}

export interface RetentionSummary {
  pending: number;
  kept: number;
  failed: number;
  /** Pending, not dry run, applyAfter within `soonDays`. */
  dueSoon: number;
  /** Bytes the pending (non-kept) candidates would free. */
  pendingBytes: number;
}

export function summarize(candidates: readonly RetentionCandidate[], now: number = Date.now(), soonDays = 7): RetentionSummary {
  const soon = now + soonDays * 86_400_000;
  let pending = 0;
  let kept = 0;
  let failed = 0;
  let dueSoon = 0;
  let pendingBytes = 0;
  for (const c of candidates) {
    if (c.status === 'pending') {
      pending++;
      pendingBytes += c.sizeBytes;
      if (!c.dryRun && new Date(c.applyAfter).getTime() <= soon) dueSoon++;
    } else if (c.status === 'kept') kept++;
    else if (c.status === 'failed') failed++;
  }
  return { pending, kept, failed, dueSoon, pendingBytes };
}

/** "Due now", "in 3d", "Kept", "—". */
export function applyAfterText(c: Pick<RetentionCandidate, 'status' | 'applyAfter' | 'appliedAt'>, now: number = Date.now()): string {
  if (c.status === 'applied') return c.appliedAt ? t('library.retention.appliedSlice', { slice: new Date(c.appliedAt).toISOString().slice(0, 10) }) : t('common.applied');
  if (c.status === 'kept') return t('common.never');
  const ms = new Date(c.applyAfter).getTime() - now;
  if (ms <= 0) return t('library.retention.dueNow');
  const days = Math.ceil(ms / 86_400_000);
  return t('library.retention.inDaysD', { days });
}

export function parseUserList(text: string): string[] {
  return [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean))];
}
