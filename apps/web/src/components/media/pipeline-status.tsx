import type {
  AutomaticSearchPlan,
  ItemSearchStatus,
  LastSearch,
  ProfileMismatchRecord,
  QueueSummaryItem,
  SearchOutcome,
  SearchRunSource,
} from '@arclight/shared';
import { StatusChip } from '../../arclight/index.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { queueChip, type QueueChip } from '../../pages/activity/queue-status.js';
import { t } from '../../i18n/index.js';

// The search → grab → download pipeline, per item: queue state chips for the library pages
// (from GET /queue/summary), "last searched · outcome" and "next automatic search" lines (GET
// /release/searchstatus) and the profile-mismatch replacement plan. Text helpers are pure so
// they can be unit tested; the components are thin.

/* ------------------------------------------------------------------ queue state */

/** Queue items by the movie / episode / series they are for (the newest item wins per key). */
export interface QueueIndex {
  movies: Map<number, QueueSummaryItem>;
  episodes: Map<number, QueueSummaryItem>;
  series: Map<number, QueueSummaryItem[]>;
}

export function buildQueueIndex(items: readonly QueueSummaryItem[] | undefined): QueueIndex {
  const index: QueueIndex = { movies: new Map(), episodes: new Map(), series: new Map() };
  for (const item of [...(items ?? [])].sort((a, b) => a.id - b.id)) {
    if (item.movieId !== undefined) index.movies.set(item.movieId, item);
    for (const id of item.episodeIds ?? []) index.episodes.set(id, item);
    if (item.seriesId !== undefined) index.series.set(item.seriesId, [...(index.series.get(item.seriesId) ?? []), item]);
  }
  return index;
}

/**
 * Chip for one download in the library's vocabulary: Queued, Downloading 42%, Importing,
 * Paused, Stalled · cause, Failed · cause. Same rules as the Activity queue, plus the state
 * code for transfers that are held while the client still says "downloading".
 */
export function summaryChip(item: QueueSummaryItem): QueueChip & { label?: string } {
  const pending = item.trackedState === 'pending';
  const chip = queueChip({
    status: item.status,
    trackedState: item.trackedState,
    trackedStatus: item.trackedStatus,
    statusMessages: [],
    downloadId: pending ? 'pending:' : '',
    downloadClientId: pending ? null : 0,
  });
  if (chip.status !== 'downloading') return chip;
  switch (item.stateCode) {
    case 'paused':
    case 'killSwitch':
    case 'diskPaused':
      return { status: 'paused' };
    case 'queued':
    case 'pendingGrab':
    case 'diskHeld':
      return { status: 'queued' };
    case 'noPeers':
    case 'stalled':
      return { status: 'stalled', cause: t('activity.queueStatus.noPeers') };
    default:
      return { status: 'downloading', label: t('components.media.kit.downloadingValue', { value: Math.round(item.progress * 100) }) };
  }
}

const CHIP_RANK: Record<QueueChip['status'], number> = { failed: 0, stalled: 1, downloading: 2, importing: 3, paused: 4, queued: 5, downloaded: 6 };

/** One chip for several downloads (a series): the state that needs attention most, plus the count. */
export function aggregateChip(items: readonly QueueSummaryItem[]): (QueueChip & { label?: string }) | null {
  if (items.length === 0) return null;
  const chips = items.map(summaryChip).sort((a, b) => CHIP_RANK[a.status] - CHIP_RANK[b.status]);
  const top = chips[0]!;
  if (items.length === 1) return top;
  const base = top.label ?? (top.cause ? `${t(`status.${top.status}`)} · ${top.cause}` : t(`status.${top.status}`));
  return { ...top, label: t('components.media.pipeline.queueCount', { label: base, count: items.length }) };
}

/** Queue chip for a library item; renders nothing when it is not in the queue. */
export function QueueStateChip({ item, items, large }: { item?: QueueSummaryItem | undefined; items?: readonly QueueSummaryItem[] | undefined; large?: boolean }) {
  const chip = item ? summaryChip(item) : aggregateChip(items ?? []);
  if (!chip) return null;
  return (
    <StatusChip
      status={chip.status}
      cause={chip.cause ?? (chip.status === 'failed' || chip.status === 'stalled' ? t('activity.queueStatus.downloadFailed') : undefined)}
      label={chip.label}
      large={large}
      data-testid="queue-state"
    />
  );
}

/* ------------------------------------------------------------------ search status */

export function outcomeLabel(outcome: SearchOutcome): string {
  switch (outcome) {
    case 'grabbed':
      return t('components.media.pipeline.outcomeGrabbed');
    case 'pending':
      return t('components.media.pipeline.outcomePending');
    case 'found':
      return t('components.media.pipeline.outcomeFound');
    case 'rejected':
      return t('components.media.pipeline.outcomeRejected');
    case 'noResults':
      return t('components.media.pipeline.outcomeNoResults');
    case 'error':
      return t('components.media.pipeline.outcomeError');
  }
}

export function sourceLabel(source: SearchRunSource): string {
  switch (source) {
    case 'automatic':
      return t('components.media.pipeline.sourceAutomatic');
    case 'manual':
      return t('components.media.pipeline.sourceManual');
    case 'interactive':
      return t('components.media.pipeline.sourceInteractive');
  }
}

/** "Last searched 3h ago · nothing found" (the rejection reason follows "all results rejected"). */
export function lastSearchText(last: LastSearch | null | undefined, now: number = Date.now()): string {
  if (!last) return t('components.media.pipeline.neverSearched');
  const outcome = last.outcome === 'rejected' && last.detail ? `${outcomeLabel(last.outcome)}: ${last.detail}` : outcomeLabel(last.outcome);
  return t('components.media.pipeline.lastSearched', { when: relativeTime(last.time, now), outcome });
}

/** Tooltip: when exactly, which kind of search, and the release / error behind the outcome. */
export function lastSearchTitle(last: LastSearch | null | undefined): string | undefined {
  if (!last) return undefined;
  const head = t('components.media.pipeline.searchOn', { source: sourceLabel(last.source), date: formatDateTime(last.time) });
  const counts = t('components.media.pipeline.releaseCounts', { releases: last.releases, approved: last.approved });
  return [head, counts, last.detail].filter(Boolean).join('\n');
}

/** Whether and when a scheduled search will look for the item. */
export function nextSearchText(plan: AutomaticSearchPlan, now: number = Date.now()): string {
  switch (plan.state) {
    case 'scheduled':
      if (!plan.nextSearchAt) return t('components.media.pipeline.nextLater');
      return plan.runsAhead > 0
        ? t('components.media.pipeline.nextQueued', { when: relativeTime(plan.nextSearchAt, now), runs: plan.runsAhead })
        : t('components.media.pipeline.nextScheduled', { when: relativeTime(plan.nextSearchAt, now) });
    case 'unmonitored':
      return t('components.media.pipeline.nextUnmonitored');
    case 'notAvailable':
      return t('components.media.pipeline.nextNotAvailable');
    case 'special':
      return t('components.media.pipeline.nextSpecial');
    case 'satisfied':
      return t('components.media.pipeline.nextSatisfied');
    case 'jobDisabled':
      return t('components.media.pipeline.nextJobDisabled', { job: plan.job ?? '' });
  }
}

/** Tooltip for the next-search line: the job, the back-off and that the time is an estimate. */
export function nextSearchTitle(plan: AutomaticSearchPlan): string | undefined {
  if (plan.state !== 'scheduled') return undefined;
  const lines = [t('components.media.pipeline.nextSearchHow', { job: plan.job ?? '', count: plan.searchCount })];
  if (plan.nextSearchAt) lines.push(formatDateTime(plan.nextSearchAt));
  return lines.join('\n');
}

/** "2 missing episodes · Next automatic search ~in 5h": the soonest scheduled search of a group. */
export function groupSearchText(statuses: readonly ItemSearchStatus[], now: number = Date.now()): string | null {
  if (statuses.length === 0) return null;
  const scheduled = statuses
    .filter((s) => s.automatic.state === 'scheduled' && s.automatic.nextSearchAt)
    .sort((a, b) => a.automatic.nextSearchAt!.localeCompare(b.automatic.nextSearchAt!));
  const pick = scheduled[0] ?? statuses[0]!;
  return t('components.media.pipeline.groupMissing', { count: statuses.length, next: nextSearchText(pick.automatic, now) });
}

/** Both lines as one tooltip (episode rows). */
export function searchStatusTitle(status: ItemSearchStatus | undefined): string | undefined {
  return status ? `${lastSearchText(status.lastSearch)}\n${nextSearchText(status.automatic)}` : undefined;
}

/** Two muted lines: last search and next automatic search. Mobile-safe (wraps). */
export function SearchStatusLines({ status, compact }: { status: ItemSearchStatus | undefined; compact?: boolean }) {
  if (!status) return null;
  return (
    <span className="mk-search-status" data-testid="search-status" data-compact={compact || undefined}>
      <span title={lastSearchTitle(status.lastSearch)}>{lastSearchText(status.lastSearch)}</span>
      <span title={nextSearchTitle(status.automatic)} data-state={status.automatic.state}>
        {nextSearchText(status.automatic)}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ profile mismatch */

/** Will this mismatched file be replaced, and when? */
export function replacementText(record: Pick<ProfileMismatchRecord, 'replacement' | 'migration'>, now: number = Date.now()): string {
  const plan = record.replacement;
  if (!plan) return '—';
  switch (plan.state) {
    case 'scheduled':
      return plan.nextSearchAt
        ? t('components.media.pipeline.replaceScheduled', { when: relativeTime(plan.nextSearchAt, now) })
        : t('components.media.pipeline.replaceLater');
    case 'downloading':
      return t('components.media.pipeline.replaceDownloading');
    case 'failed':
      return t('components.media.pipeline.replaceFailed', { attempts: record.migration?.attempts ?? plan.maxAttempts });
    case 'manualOnly':
      return t('components.media.pipeline.replaceManualOnly');
    case 'paused':
      return t('components.media.pipeline.replacePaused');
    case 'globalOff':
      return t('components.media.pipeline.replaceGlobalOff');
    case 'noRule':
      return t('components.media.pipeline.replaceNoRule');
    case 'cutoffSearch':
      return t('components.media.pipeline.replaceCutoffSearch');
    case 'unmonitored':
      return t('components.media.pipeline.replaceUnmonitored');
  }
}
