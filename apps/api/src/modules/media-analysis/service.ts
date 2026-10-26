import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { MediaAnalysisQueueSummary, MediaInfo, MediaType } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { mediaFiles } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import type { MediaProber } from './runner.js';
import { mediaAnalysisJobs } from './schema.js';

// The persisted analysis queue. Files are enqueued on import (and on any `library fileAdded`
// for files still without media info) or by POST /command/analyze; the AnalyzeMedia job drains
// the queue with N workers, writes `media_files.media_info` and publishes `library updated`.

export class MediaAnalysisError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'VALIDATION',
    message: string,
  ) {
    super(message);
    this.name = 'MediaAnalysisError';
  }
}

export interface MediaAnalysisQueueOptions {
  db: Db;
  prober: MediaProber;
  bus?: EventBus;
  log?: Logger;
  /** Files analyzed in parallel. Default `ARCLIGHT_ANALYSIS_CONCURRENCY` or 2. */
  concurrency?: number;
  now?: () => Date;
}

export interface AnalyzeTarget {
  seriesId?: number | undefined;
  movieId?: number | undefined;
  all?: boolean | undefined;
  /** Re-analyze files that already have media info. */
  force?: boolean | undefined;
}

export interface ProcessResult {
  /** True when nothing ran because ffprobe is missing. */
  skipped: boolean;
  done: number;
  failed: number;
  /** Queue rows dropped because their media file no longer exists. */
  pruned: number;
}

export function defaultConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['ARCLIGHT_ANALYSIS_CONCURRENCY']);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 2;
}

export class MediaAnalysisQueue {
  readonly concurrency: number;
  private readonly db: Db;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private active: Promise<ProcessResult> | null = null;
  private kicker: (() => void) | null = null;

  constructor(private readonly opts: MediaAnalysisQueueOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? defaultConcurrency()));
  }

  get prober(): MediaProber {
    return this.opts.prober;
  }

  get processing(): boolean {
    return this.active !== null;
  }

  /** Called after an enqueue while the queue is idle (the module starts the AnalyzeMedia job). */
  setKicker(fn: (() => void) | null): void {
    this.kicker = fn;
  }

  private kick(): void {
    if (!this.active && this.kicker) {
      try {
        this.kicker();
      } catch (err) {
        this.log?.warn({ err }, 'could not start media analysis');
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // Enqueue
  // -------------------------------------------------------------------------------------

  /** Queue (or re-queue) files. Rows currently running are left alone. Returns rows queued. */
  enqueue(fileIds: readonly number[], opts: { kick?: boolean } = {}): number {
    const ids = [...new Set(fileIds)].filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return 0;
    const at = this.now().toISOString();
    let queued = 0;
    this.db.transaction((tx) => {
      for (const id of ids) {
        const r = tx
          .insert(mediaAnalysisJobs)
          .values({ mediaFileId: id, status: 'pending', queuedAt: at })
          .onConflictDoUpdate({
            target: mediaAnalysisJobs.mediaFileId,
            set: { status: 'pending', error: null, queuedAt: at, startedAt: null, finishedAt: null },
            setWhere: ne(mediaAnalysisJobs.status, 'running'),
          })
          .run();
        queued += r.changes;
      }
    });
    if (queued > 0 && (opts.kick ?? true)) this.kick();
    return queued;
  }

  /** Files of a series, a movie, or the whole library. */
  enqueueFor(target: AnalyzeTarget): number {
    const where = [];
    if (target.seriesId !== undefined) where.push(eq(mediaFiles.seriesId, target.seriesId));
    else if (target.movieId !== undefined) where.push(eq(mediaFiles.movieId, target.movieId));
    else if (!target.all) throw new MediaAnalysisError('VALIDATION', 'seriesId, movieId or all is required');
    const force = target.force ?? !target.all;
    if (!force) where.push(isNull(mediaFiles.mediaInfo));
    const rows = this.db.select({ id: mediaFiles.id }).from(mediaFiles).where(and(...where)).all();
    if (rows.length === 0 && !target.all) {
      // Distinguish "nothing to do" from "no such item" only by the item having no files; both are fine.
      return 0;
    }
    return this.enqueue(rows.map((r) => r.id));
  }

  /** Files of one series/movie with no media info and no queue row yet (bus `fileAdded`). */
  enqueueMissingFor(mediaType: MediaType, parentId: number): number {
    const parent = mediaType === 'series' ? eq(mediaFiles.seriesId, parentId) : eq(mediaFiles.movieId, parentId);
    const rows = this.db
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .leftJoin(mediaAnalysisJobs, eq(mediaAnalysisJobs.mediaFileId, mediaFiles.id))
      .where(and(parent, isNull(mediaFiles.mediaInfo), isNull(mediaAnalysisJobs.id)))
      .all();
    return this.enqueue(rows.map((r) => r.id));
  }

  /** Every file without media info and no queue row (the scheduled run picks these up). */
  enqueueAllMissing(): number {
    const rows = this.db
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .leftJoin(mediaAnalysisJobs, eq(mediaAnalysisJobs.mediaFileId, mediaFiles.id))
      .where(and(isNull(mediaFiles.mediaInfo), isNull(mediaAnalysisJobs.id)))
      .all();
    return this.enqueue(
      rows.map((r) => r.id),
      { kick: false },
    );
  }

  /** Rows left `running` by a crash or restart go back to pending. */
  recoverInterrupted(): number {
    return this.db
      .update(mediaAnalysisJobs)
      .set({ status: 'pending', startedAt: null })
      .where(eq(mediaAnalysisJobs.status, 'running'))
      .run().changes;
  }

  // -------------------------------------------------------------------------------------
  // Processing
  // -------------------------------------------------------------------------------------

  /** Drain the queue with `concurrency` workers. Concurrent callers share one run. */
  process(opts: { signal?: AbortSignal } = {}): Promise<ProcessResult> {
    this.active ??= this.drain(opts.signal).finally(() => {
      this.active = null;
    });
    return this.active;
  }

  private claimNext(): { jobId: number; mediaFileId: number } | null {
    // better-sqlite3 is synchronous: select + conditional update cannot interleave with
    // another worker's claim.
    const row = this.db
      .select({ id: mediaAnalysisJobs.id, mediaFileId: mediaAnalysisJobs.mediaFileId })
      .from(mediaAnalysisJobs)
      .where(eq(mediaAnalysisJobs.status, 'pending'))
      .orderBy(asc(mediaAnalysisJobs.queuedAt), asc(mediaAnalysisJobs.id))
      .limit(1)
      .get();
    if (!row) return null;
    const claimed = this.db
      .update(mediaAnalysisJobs)
      .set({ status: 'running', startedAt: this.now().toISOString(), attempts: sql`${mediaAnalysisJobs.attempts} + 1` })
      .where(and(eq(mediaAnalysisJobs.id, row.id), eq(mediaAnalysisJobs.status, 'pending')))
      .run().changes;
    return claimed ? { jobId: row.id, mediaFileId: row.mediaFileId } : this.claimNext();
  }

  private async drain(signal?: AbortSignal): Promise<ProcessResult> {
    const result: ProcessResult = { skipped: false, done: 0, failed: 0, pruned: 0 };
    const binary = await this.opts.prober.locate();
    if (!binary) {
      result.skipped = true;
      return result;
    }
    const worker = async () => {
      for (;;) {
        if (signal?.aborted) return;
        const next = this.claimNext();
        if (!next) return;
        await this.analyzeOne(next.jobId, next.mediaFileId, result);
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, () => worker()));
    // Aborted mid-run: anything claimed but unfinished is already settled by analyzeOne.
    return result;
  }

  private async analyzeOne(jobId: number, mediaFileId: number, result: ProcessResult): Promise<void> {
    const file = this.db
      .select({ id: mediaFiles.id, path: mediaFiles.path, mediaType: mediaFiles.mediaType, seriesId: mediaFiles.seriesId, movieId: mediaFiles.movieId })
      .from(mediaFiles)
      .where(eq(mediaFiles.id, mediaFileId))
      .get();
    if (!file) {
      this.db.delete(mediaAnalysisJobs).where(eq(mediaAnalysisJobs.id, jobId)).run();
      result.pruned++;
      return;
    }
    let info: MediaInfo;
    try {
      info = await this.opts.prober.analyze(file.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log?.warn({ err, path: file.path }, 'media analysis failed');
      this.db
        .update(mediaAnalysisJobs)
        .set({ status: 'failed', error: message.slice(0, 1000), finishedAt: this.now().toISOString() })
        .where(eq(mediaAnalysisJobs.id, jobId))
        .run();
      result.failed++;
      return;
    }
    // The file row may have been deleted while ffprobe ran.
    const updated = this.db.update(mediaFiles).set({ mediaInfo: info }).where(eq(mediaFiles.id, file.id)).run().changes;
    if (!updated) {
      this.db.delete(mediaAnalysisJobs).where(eq(mediaAnalysisJobs.id, jobId)).run();
      result.pruned++;
      return;
    }
    this.db
      .update(mediaAnalysisJobs)
      .set({ status: 'done', error: null, finishedAt: this.now().toISOString() })
      .where(eq(mediaAnalysisJobs.id, jobId))
      .run();
    result.done++;
    const parentId = file.mediaType === 'series' ? file.seriesId : file.movieId;
    if (parentId != null) this.bus?.publish({ type: 'library', action: 'updated', mediaType: file.mediaType, id: parentId });
  }

  // -------------------------------------------------------------------------------------
  // Read side
  // -------------------------------------------------------------------------------------

  async summary(): Promise<MediaAnalysisQueueSummary> {
    const counts = this.db
      .select({ status: mediaAnalysisJobs.status, n: sql<number>`count(*)` })
      .from(mediaAnalysisJobs)
      .groupBy(mediaAnalysisJobs.status)
      .all();
    const count = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    const failures = this.db
      .select({ mediaFileId: mediaAnalysisJobs.mediaFileId, error: mediaAnalysisJobs.error, finishedAt: mediaAnalysisJobs.finishedAt, path: mediaFiles.path })
      .from(mediaAnalysisJobs)
      .leftJoin(mediaFiles, eq(mediaFiles.id, mediaAnalysisJobs.mediaFileId))
      .where(eq(mediaAnalysisJobs.status, 'failed'))
      .orderBy(desc(mediaAnalysisJobs.finishedAt))
      .limit(20)
      .all();
    return {
      ffprobePath: await this.opts.prober.locate(),
      concurrency: this.concurrency,
      pending: count('pending'),
      running: count('running'),
      done: count('done'),
      failed: count('failed'),
      recentFailures: failures.map((f) => ({ mediaFileId: f.mediaFileId, path: f.path ?? null, error: f.error ?? '', finishedAt: f.finishedAt })),
    };
  }

  /** Queue rows for the given files (tests, UI detail). */
  jobsFor(fileIds: readonly number[]) {
    if (fileIds.length === 0) return [];
    return this.db.select().from(mediaAnalysisJobs).where(inArray(mediaAnalysisJobs.mediaFileId, [...fileIds])).all();
  }
}
