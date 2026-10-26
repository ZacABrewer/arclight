import type { DecisionLogBatch, DecisionLogEntry, DecisionLogSource, ReleaseRejection } from '@arclight/shared';
import type { DecisionScope } from '../../../api/decisions.js';
import type { ChipTone } from '../../../arclight/index.js';
import type { HistorySearch } from '../../activity/history-search.js';
import { t } from '../../../i18n/index.js';

// Pure helpers for the decision log views (details "Decisions" tab, episode drawer, History).

export const DECISION_SOURCE_LABELS: Record<DecisionLogSource, string> = {
  get rss() {
    return t('library.decisions.sourceRss');
  },
  get search() {
    return t('library.decisions.sourceSearch');
  },
  get interactive() {
    return t('library.decisions.sourceInteractive');
  },
  get push() {
    return t('library.decisions.sourcePush');
  },
  get pending() {
    return t('library.decisions.sourcePending');
  },
};

export function decisionSourceLabel(source: string): string {
  return DECISION_SOURCE_LABELS[source as DecisionLogSource] ?? source;
}

/**
 * Rows in the engine's preference order: rank ascending (unranked last), then approved first,
 * then higher score. The api already sends rank order; this keeps the view stable regardless.
 */
export function orderDecisions(rows: readonly DecisionLogEntry[]): DecisionLogEntry[] {
  return [...rows].sort((a, b) => {
    if (a.rank !== b.rank) {
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank - b.rank;
    }
    if (a.approved !== b.approved) return a.approved ? -1 : 1;
    return b.score - a.score || a.id - b.id;
  });
}

export type DecisionRowState = 'grabbed' | 'winner' | 'approved' | 'rejected';

/** grabbed: chosen from this batch. winner: the batch's best approved row (nothing grabbed). */
export function decisionRowState(row: Pick<DecisionLogEntry, 'id' | 'chosen' | 'approved'>, winnerId: number | null): DecisionRowState {
  if (row.chosen) return 'grabbed';
  if (row.id === winnerId) return 'winner';
  return row.approved ? 'approved' : 'rejected';
}

/** Temporary rejections (delay, queue full, …) read as attention; permanent ones as failures. */
export function rejectionTone(r: Pick<ReleaseRejection, 'type'>): ChipTone {
  return r.type === 'temporary' ? 'warn' : 'danger';
}

/** "24 releases · 3 approved · 21 rejected". */
export function batchCounts(batch: Pick<DecisionLogBatch, 'total' | 'approved'>): string {
  return t('library.decisions.batchCounts', { total: batch.total, approved: batch.approved, rejected: Math.max(0, batch.total - batch.approved) });
}

/**
 * Where "View grab in History" points for a batch that grabbed: grabbed events of the listed
 * item, narrowed to the grabbed episode when the batch grabbed exactly one. Null when nothing
 * was grabbed.
 */
export function grabHistorySearch(batch: Pick<DecisionLogBatch, 'grabbed' | 'decisions'>, scope: DecisionScope): HistorySearch | null {
  if (!batch.grabbed) return null;
  if ('episodeId' in scope) return { eventType: 'grabbed', episodeId: scope.episodeId };
  if ('movieId' in scope) return { eventType: 'grabbed', movieId: scope.movieId };
  const chosen = batch.decisions.find((d) => d.chosen);
  const only = chosen?.episodeIds.length === 1 ? chosen.episodeIds[0] : undefined;
  return only !== undefined ? { eventType: 'grabbed', episodeId: only } : { eventType: 'grabbed', seriesId: scope.seriesId };
}

/** Page count for a paged response. */
export function pageCount(totalRecords: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalRecords / Math.max(1, pageSize)));
}
