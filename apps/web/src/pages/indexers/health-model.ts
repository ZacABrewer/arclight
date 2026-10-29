import type { IndexerHealthEntry, IndexerHealthThresholds, IndexerHealthVerdict, IndexerUpdate } from '@arclight/shared';
import type { ChipTone } from '../../arclight/index.js';
import { formatDuration, formatPercent, t } from '../../i18n/index.js';

// Indexer health table helpers (health-table.tsx). Verdicts come from the api
// (apps/api/src/modules/indexers/health.ts); this only presents them.

/** Chip tone per verdict: never colour alone, the chip always carries the label too. */
export const VERDICT_TONE: Record<IndexerHealthVerdict, ChipTone> = {
  healthy: 'accent',
  slow: 'warn',
  noResults: 'warn',
  failing: 'danger',
  unused: 'muted',
};

/** Worst first, so a descending sort on the verdict column surfaces problems. */
export const VERDICT_RANK: Record<IndexerHealthVerdict, number> = {
  failing: 4,
  noResults: 3,
  slow: 2,
  unused: 1,
  healthy: 0,
};

export function verdictLabel(verdict: IndexerHealthVerdict): string {
  switch (verdict) {
    case 'healthy':
      return t('indexers.health.verdictHealthy');
    case 'slow':
      return t('indexers.health.verdictSlow');
    case 'failing':
      return t('indexers.health.verdictFailing');
    case 'unused':
      return t('indexers.health.verdictUnused');
    case 'noResults':
      return t('indexers.health.verdictNoResults');
  }
}

/** One sentence saying why the verdict applies (chip tooltip). */
export function verdictReason(e: IndexerHealthEntry, th: IndexerHealthThresholds): string {
  switch (e.verdict) {
    case 'failing':
      return e.disabledTill
        ? t('indexers.health.reasonBackingOff', { count: e.failureCount })
        : t('indexers.health.reasonFailing', { rate: formatPercent(e.failureRate), threshold: formatPercent(th.failureRate) });
    case 'noResults':
      return t('indexers.health.reasonNoResults', { rate: formatPercent(e.zeroResultRate), threshold: formatPercent(th.zeroResultRate) });
    case 'slow':
      return t('indexers.health.reasonSlow', {
        avg: formatDuration(e.avgResponseMs),
        p95: formatDuration(e.p95ResponseMs),
        avgThreshold: formatDuration(th.slowAvgMs),
        p95Threshold: formatDuration(th.slowP95Ms),
      });
    case 'unused':
      return t('indexers.health.reasonUnused');
    case 'healthy':
      return t('indexers.health.reasonHealthy');
  }
}

/** Body for the Enable / Disable action: all three uses switched together. */
export function toggleEnabledBody(enabled: boolean): IndexerUpdate {
  const on = !enabled;
  return { enableRss: on, enableAutomaticSearch: on, enableInteractiveSearch: on };
}

/** "12.5" / "—" for average results per query. */
export function formatAvgResults(value: number | null): string {
  return value === null ? '—' : String(Math.round(value * 10) / 10);
}

/** Percent of a 0–1 ratio, "—" when unknown. */
export function formatRatio(value: number | null): string {
  return value === null ? '—' : formatPercent(value);
}

/** Problems first (verdict rank), then by name. */
export function healthOrder(a: IndexerHealthEntry, b: IndexerHealthEntry): number {
  return VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict] || a.indexerName.localeCompare(b.indexerName);
}
