import { and, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import type { IndexerStatKind, IndexerStats, IndexerStatsDay } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import type { HealthSample, LatestOutcome } from './health.js';
import { indexers, indexerStats } from './schema.js';

// Append-only indexer usage log: one row per query / RSS fetch / grab. Aggregated on read.

export const STATS_RETENTION_DAYS = 90;
/** Longest failure message kept on a stats row. */
export const STATS_ERROR_MAX = 300;
const DAY = 24 * 60 * 60 * 1000;

export class IndexerStatsRecorder {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Append one row. `detail.results` is the number of releases a query / RSS fetch returned;
   * `detail.error` a short failure message (truncated to {@link STATS_ERROR_MAX} characters).
   */
  record(
    indexerId: number,
    kind: IndexerStatKind,
    durationMs: number,
    success: boolean,
    detail: { results?: number | undefined; error?: string | undefined } = {},
  ): void {
    if (indexerId <= 0) return;
    const error = !success && detail.error ? truncate(detail.error, STATS_ERROR_MAX) : null;
    const results = detail.results !== undefined && Number.isFinite(detail.results) ? Math.max(0, Math.round(detail.results)) : null;
    try {
      this.db
        .insert(indexerStats)
        .values({
          indexerId,
          kind,
          durationMs: Math.max(0, Math.round(durationMs)),
          success,
          results,
          error,
          at: new Date(this.now()).toISOString(),
        })
        .run();
    } catch {
      // The indexer was deleted mid-operation (FK); a lost stat row is harmless.
    }
  }

  /** Delete rows older than the retention window; returns the number removed. */
  prune(retentionDays = STATS_RETENTION_DAYS): number {
    const cutoff = new Date(this.now() - retentionDays * DAY).toISOString();
    return this.db.delete(indexerStats).where(lt(indexerStats.at, cutoff)).run().changes;
  }

  /** Every row since `since` (ISO-8601), for the health summary. */
  samplesSince(since: string): HealthSample[] {
    return this.db
      .select({
        indexerId: indexerStats.indexerId,
        kind: indexerStats.kind,
        success: indexerStats.success,
        durationMs: indexerStats.durationMs,
        results: indexerStats.results,
      })
      .from(indexerStats)
      .where(gte(indexerStats.at, since))
      .all();
  }

  /**
   * Newest successful and failed query / RSS fetch per indexer over the whole retained log,
   * with the failure's message.
   */
  latestOutcomes(): Map<number, LatestOutcome> {
    const out = new Map<number, LatestOutcome>();
    const get = (id: number) => out.get(id) ?? out.set(id, { lastSuccessAt: null, lastFailureAt: null, lastFailureMessage: null }).get(id)!;
    const latest = this.db
      .select({ indexerId: indexerStats.indexerId, success: indexerStats.success, at: sql<string>`max(${indexerStats.at})` })
      .from(indexerStats)
      .where(ne(indexerStats.kind, 'grab'))
      .groupBy(indexerStats.indexerId, indexerStats.success)
      .all();
    for (const row of latest) {
      const entry = get(row.indexerId);
      if (row.success) {
        entry.lastSuccessAt = row.at;
      } else {
        entry.lastFailureAt = row.at;
        const failed = this.db
          .select({ error: indexerStats.error })
          .from(indexerStats)
          .where(and(eq(indexerStats.indexerId, row.indexerId), eq(indexerStats.success, false), eq(indexerStats.at, row.at), ne(indexerStats.kind, 'grab')))
          .orderBy(desc(indexerStats.id))
          .get();
        entry.lastFailureMessage = failed?.error ?? null;
      }
    }
    return out;
  }

  /** Per-indexer and total counts for the last `days` days (today included), by UTC day. */
  query(days: number): IndexerStats {
    const today = startOfUtcDay(this.now());
    const sinceMs = today - (days - 1) * DAY;
    const since = new Date(sinceMs).toISOString();
    const dates = Array.from({ length: days }, (_, i) => new Date(sinceMs + i * DAY).toISOString().slice(0, 10));

    const day = sql<string>`substr(${indexerStats.at}, 1, 10)`;
    const grouped = this.db
      .select({
        indexerId: indexerStats.indexerId,
        day,
        kind: indexerStats.kind,
        success: indexerStats.success,
        count: sql<number>`count(*)`,
        totalMs: sql<number>`sum(${indexerStats.durationMs})`,
      })
      .from(indexerStats)
      .where(and(gte(indexerStats.at, since)))
      .groupBy(indexerStats.indexerId, day, indexerStats.kind, indexerStats.success)
      .all();

    const names = new Map(this.db.select({ id: indexers.id, name: indexers.name }).from(indexers).all().map((r) => [r.id, r.name]));
    interface Acc {
      queries: number;
      grabs: number;
      failures: number;
      okQueries: number;
      okMs: number;
      byDay: Map<string, IndexerStatsDay>;
    }
    const empty = (): Acc => ({
      queries: 0,
      grabs: 0,
      failures: 0,
      okQueries: 0,
      okMs: 0,
      byDay: new Map(dates.map((d) => [d, { date: d, queries: 0, grabs: 0, failures: 0 }])),
    });
    const per = new Map<number, Acc>();
    for (const id of names.keys()) per.set(id, empty());
    const total = empty();

    for (const g of grouped) {
      const acc = per.get(g.indexerId) ?? per.set(g.indexerId, empty()).get(g.indexerId)!;
      const count = Number(g.count);
      for (const a of [acc, total]) {
        const d = a.byDay.get(g.day);
        if (g.kind === 'grab') {
          a.grabs += count;
          if (d) d.grabs += count;
        } else {
          a.queries += count;
          if (d) d.queries += count;
          if (g.success) {
            a.okQueries += count;
            a.okMs += Number(g.totalMs);
          }
        }
        if (!g.success) {
          a.failures += count;
          if (d) d.failures += count;
        }
      }
    }

    const avg = (a: Acc) => (a.okQueries > 0 ? Math.round(a.okMs / a.okQueries) : null);
    return {
      days,
      since,
      indexers: [...per.entries()]
        .map(([indexerId, a]) => ({
          indexerId,
          indexerName: names.get(indexerId) ?? `#${indexerId}`,
          queries: a.queries,
          grabs: a.grabs,
          failures: a.failures,
          avgResponseMs: avg(a),
          byDay: [...a.byDay.values()],
        }))
        .sort((a, b) => b.queries - a.queries || a.indexerName.localeCompare(b.indexerName)),
      totals: {
        queries: total.queries,
        grabs: total.grabs,
        failures: total.failures,
        avgResponseMs: avg(total),
        byDay: [...total.byDay.values()],
      },
    };
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}
