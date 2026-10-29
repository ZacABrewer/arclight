import type {
  IndexerHealth,
  IndexerHealthEntry,
  IndexerHealthThresholds,
  IndexerHealthVerdict,
  IndexerStatKind,
} from '@arclight/shared';

// Per-indexer health summary, aggregated from the stats log. Pure: the service supplies the
// rows, indexer list, backoff state and clock.

/**
 * Verdict thresholds (docs/using/indexers.md § Indexer health):
 *   failing   — backing off now, or ≥ 25% of queries + RSS fetches failed
 *   noResults — ≥ 10 successful queries with a result count, ≥ 90% of them empty
 *   slow      — average ≥ 5 s or p95 ≥ 10 s over successful queries
 */
export const INDEXER_HEALTH_THRESHOLDS: IndexerHealthThresholds = {
  failureRate: 0.25,
  slowAvgMs: 5_000,
  slowP95Ms: 10_000,
  zeroResultRate: 0.9,
  minQueriesForNoResults: 10,
};

const DAY = 24 * 60 * 60 * 1000;

/** One stats row, as the health summary needs it. */
export interface HealthSample {
  indexerId: number;
  kind: IndexerStatKind;
  success: boolean;
  durationMs: number;
  results: number | null;
}

/** Newest successful / failed query per indexer (whole retained log). */
export interface LatestOutcome {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
}

export interface HealthIndexer {
  id: number;
  name: string;
  enabled: boolean;
}

/** Backoff state from `indexer_status`. */
export interface HealthStatus {
  failureCount: number;
  disabledTill: string | null;
  lastFailure: string | null;
  mostRecentFailure: string | null;
}

export interface HealthInput {
  days: number;
  now: number;
  indexers: readonly HealthIndexer[];
  samples: readonly HealthSample[];
  latest?: ReadonlyMap<number, LatestOutcome> | undefined;
  statuses?: ReadonlyMap<number, HealthStatus> | undefined;
  thresholds?: IndexerHealthThresholds | undefined;
}

/** Metrics the verdict is decided from. */
export type VerdictMetrics = Pick<
  IndexerHealthEntry,
  'queries' | 'failureRate' | 'avgResponseMs' | 'p95ResponseMs' | 'zeroResultRate'
> & { backingOff: boolean; countedQueries: number };

/** Nearest-rank percentile (`p` in 0–100) of unsorted values; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

/** First matching verdict: unused → failing → noResults → slow → healthy. */
export function healthVerdict(m: VerdictMetrics, thresholds: IndexerHealthThresholds = INDEXER_HEALTH_THRESHOLDS): IndexerHealthVerdict {
  if (m.queries === 0 && !m.backingOff) return 'unused';
  if (m.backingOff || (m.failureRate !== null && m.failureRate >= thresholds.failureRate)) return 'failing';
  if (
    m.zeroResultRate !== null &&
    m.countedQueries >= thresholds.minQueriesForNoResults &&
    m.zeroResultRate >= thresholds.zeroResultRate
  ) {
    return 'noResults';
  }
  if ((m.avgResponseMs !== null && m.avgResponseMs >= thresholds.slowAvgMs) || (m.p95ResponseMs !== null && m.p95ResponseMs >= thresholds.slowP95Ms)) {
    return 'slow';
  }
  return 'healthy';
}

interface Acc {
  queries: number;
  failures: number;
  durations: number[];
  counted: number;
  resultSum: number;
  zero: number;
  grabs: number;
}

const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Build the health summary: one entry per indexer (all listed indexers, even idle ones). */
export function summarizeHealth(input: HealthInput): IndexerHealth {
  const thresholds = input.thresholds ?? INDEXER_HEALTH_THRESHOLDS;
  const acc = new Map<number, Acc>();
  const get = (id: number) =>
    acc.get(id) ?? acc.set(id, { queries: 0, failures: 0, durations: [], counted: 0, resultSum: 0, zero: 0, grabs: 0 }).get(id)!;

  for (const s of input.samples) {
    const a = get(s.indexerId);
    if (s.kind === 'grab') {
      if (s.success) a.grabs++;
      continue;
    }
    a.queries++;
    if (!s.success) {
      a.failures++;
      continue;
    }
    a.durations.push(s.durationMs);
    if (s.results !== null) {
      a.counted++;
      a.resultSum += s.results;
      if (s.results === 0) a.zero++;
    }
  }

  const entries = input.indexers.map((ix): IndexerHealthEntry => {
    const a = get(ix.id);
    const status = input.statuses?.get(ix.id);
    const latest = input.latest?.get(ix.id);
    const till = status?.disabledTill ? Date.parse(status.disabledTill) : NaN;
    const backingOff = !Number.isNaN(till) && till > input.now;
    const avg = a.durations.length > 0 ? Math.round(a.durations.reduce((x, y) => x + y, 0) / a.durations.length) : null;
    const metrics: VerdictMetrics = {
      queries: a.queries,
      failureRate: a.queries > 0 ? round(a.failures / a.queries, 4) : null,
      avgResponseMs: avg,
      p95ResponseMs: percentile(a.durations, 95),
      zeroResultRate: a.counted > 0 ? round(a.zero / a.counted, 4) : null,
      backingOff,
      countedQueries: a.counted,
    };
    // The stats log wins; the backoff row covers failures from before result logging (or caps probes).
    const statusIsNewer = status?.lastFailure && (!latest?.lastFailureAt || status.lastFailure > latest.lastFailureAt);
    const lastFailureAt = statusIsNewer ? status!.lastFailure : (latest?.lastFailureAt ?? null);
    const lastFailureMessage = statusIsNewer ? (status!.mostRecentFailure ?? null) : (latest?.lastFailureMessage ?? null);
    return {
      indexerId: ix.id,
      indexerName: ix.name,
      enabled: ix.enabled,
      queries: a.queries,
      failures: a.failures,
      failureRate: metrics.failureRate,
      avgResponseMs: metrics.avgResponseMs,
      p95ResponseMs: metrics.p95ResponseMs,
      avgResults: a.counted > 0 ? round(a.resultSum / a.counted, 1) : null,
      zeroResultRate: metrics.zeroResultRate,
      grabs: a.grabs,
      lastSuccessAt: latest?.lastSuccessAt ?? null,
      lastFailureAt,
      lastFailureMessage,
      failureCount: status?.failureCount ?? 0,
      disabledTill: backingOff ? status!.disabledTill : null,
      verdict: healthVerdict(metrics, thresholds),
    };
  });

  return {
    days: input.days,
    since: new Date(input.now - input.days * DAY).toISOString(),
    thresholds,
    indexers: entries.sort((x, y) => x.indexerName.localeCompare(y.indexerName)),
  };
}
