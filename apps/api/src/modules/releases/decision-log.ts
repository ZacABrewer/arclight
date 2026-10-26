import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type {
  DecisionLogBatch,
  DecisionLogEntry,
  DecisionLogPage,
  DecisionLogQuery,
  DecisionLogSource,
  ReleaseSource,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { releaseDecisions } from './schema.js';

// The release decision log: every evaluation batch is written here (one row per release that
// maps to, or was searched for, a library item) so the UI can show why a release was or was
// not grabbed. Kept per item to the last BATCHES_PER_ITEM batches and pruned by age nightly.

export const BATCHES_PER_ITEM = 20;

type Row = typeof releaseDecisions.$inferSelect;
export type DecisionLogRow = Omit<typeof releaseDecisions.$inferInsert, 'id' | 'batchId' | 'time' | 'source' | 'itemKey'>;

export function toLogSource(source: ReleaseSource): DecisionLogSource {
  switch (source) {
    case 'rss':
      return 'rss';
    case 'search':
    case 'userInvokedSearch':
      return 'search';
    case 'interactiveSearch':
      return 'interactive';
    case 'releasePush':
      return 'push';
  }
}

function itemKeyOf(row: { seriesId?: number | null | undefined; movieId?: number | null | undefined }): string | null {
  if (row.movieId != null) return `m${row.movieId}`;
  if (row.seriesId != null) return `s${row.seriesId}`;
  return null;
}

function toEntry(row: Row): DecisionLogEntry {
  const { itemKey: _key, ...rest } = row;
  return rest;
}

function compareRows(a: Row, b: Row): number {
  return (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || Number(b.approved) - Number(a.approved) || a.id - b.id;
}

function toBatch(rows: Row[]): DecisionLogBatch {
  const sorted = [...rows].sort(compareRows);
  const first = sorted[0]!;
  const chosen = sorted.find((r) => r.chosen);
  const bestApproved = sorted.find((r) => r.approved);
  return {
    batchId: first.batchId,
    time: first.time,
    source: first.source,
    total: sorted.length,
    approved: sorted.filter((r) => r.approved).length,
    grabbed: chosen !== undefined,
    winnerId: (chosen ?? bestApproved)?.id ?? null,
    decisions: sorted.map(toEntry),
  };
}

export class DecisionLogNotFound extends Error {
  readonly code = 'NOT_FOUND';
}

export class DecisionLog {
  constructor(
    private readonly db: Db,
    private readonly batchesPerItem = BATCHES_PER_ITEM,
  ) {}

  /** Write one batch; rows without a library item are dropped. Returns the rows written. */
  record(batch: { batchId: string; time: string; source: DecisionLogSource }, rows: readonly DecisionLogRow[]): number {
    const values = rows
      .map((r) => ({ ...r, itemKey: itemKeyOf(r), batchId: batch.batchId, time: batch.time, source: batch.source }))
      .filter((r): r is typeof r & { itemKey: string } => r.itemKey !== null);
    if (values.length === 0) return 0;
    const keys = new Set(values.map((v) => v.itemKey));
    this.db.transaction((tx) => {
      for (let i = 0; i < values.length; i += 200) tx.insert(releaseDecisions).values(values.slice(i, i + 200)).run();
      for (const key of keys) {
        const batches = tx
          .select({ batchId: releaseDecisions.batchId, last: sql<string>`max(${releaseDecisions.time})`, lastId: sql<number>`max(${releaseDecisions.id})` })
          .from(releaseDecisions)
          .where(eq(releaseDecisions.itemKey, key))
          .groupBy(releaseDecisions.batchId)
          .orderBy(desc(sql`max(${releaseDecisions.time})`), desc(sql`max(${releaseDecisions.id})`))
          .all();
        const doomed = batches.slice(this.batchesPerItem).map((b) => b.batchId);
        if (doomed.length > 0) {
          tx.delete(releaseDecisions).where(and(eq(releaseDecisions.itemKey, key), inArray(releaseDecisions.batchId, doomed))).run();
        }
      }
    });
    return values.length;
  }

  /**
   * Batches for one item, newest first. Per episode: the series's batches, keeping the rows that
   * cover the episode (`seriesIdForEpisode` resolves its series).
   */
  list(query: DecisionLogQuery, seriesIdForEpisode: (episodeId: number) => number): DecisionLogPage {
    let rows: Row[];
    if (query.movieId !== undefined) {
      rows = this.db.select().from(releaseDecisions).where(eq(releaseDecisions.itemKey, `m${query.movieId}`)).all();
    } else if (query.seriesId !== undefined) {
      rows = this.db.select().from(releaseDecisions).where(eq(releaseDecisions.itemKey, `s${query.seriesId}`)).all();
    } else {
      const episodeId = query.episodeId!;
      const seriesId = seriesIdForEpisode(episodeId);
      rows = this.db
        .select()
        .from(releaseDecisions)
        .where(eq(releaseDecisions.itemKey, `s${seriesId}`))
        .all()
        .filter((r) => r.episodeIds.includes(episodeId));
    }
    const groups = new Map<string, Row[]>();
    for (const r of rows) groups.set(r.batchId, [...(groups.get(r.batchId) ?? []), r]);
    const batches = [...groups.values()]
      .map(toBatch)
      .sort((a, b) => b.time.localeCompare(a.time) || Math.max(...b.decisions.map((d) => d.id)) - Math.max(...a.decisions.map((d) => d.id)));
    const start = (query.page - 1) * query.pageSize;
    return { page: query.page, pageSize: query.pageSize, totalRecords: batches.length, records: batches.slice(start, start + query.pageSize) };
  }

  /** Every row of one batch (all items). */
  getBatch(batchId: string): DecisionLogBatch {
    const rows = this.db.select().from(releaseDecisions).where(eq(releaseDecisions.batchId, batchId)).all();
    if (rows.length === 0) throw new DecisionLogNotFound(`Decision batch ${batchId} not found`);
    return toBatch(rows);
  }

  /** Delete rows older than `days` days. Returns the number of rows removed. */
  cleanup(days: number, now: Date): number {
    const cutoff = new Date(now.getTime() - days * 24 * 3_600_000).toISOString();
    return this.db.delete(releaseDecisions).where(lt(releaseDecisions.time, cutoff)).run().changes;
  }
}
