import { rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  TranscodeHwaccelResponse,
  TranscodeJob,
  TranscodeJobStatus,
  TranscodeJobTrigger,
  TranscodeRule,
  TranscodeRuleInput,
  TranscodeRunResult,
  TranscodeSettings,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, history, mediaFiles, movies, series } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { normalizeData } from '../history/index.js';
import { RecycleBin } from '../imports/mover.js';
import { getSection, setSection } from '../settings/service.js';
import { buildFfmpegArgs, containerExtension, formatCommand, softwareOptions, validateOptions, TranscodeBuildError } from './ffmpeg.js';
import { HWACCEL_NAMES, hwFailureMessage, hwFallbackNote, hwInitFailure, testBackends } from './hwaccel.js';
import { inWindow, ruleMatches, type MatchableParent } from './match.js';
import { durationMsOf, FfmpegProgressParser } from './progress.js';
import { parseHwaccels, type RunningProcess, type TranscodeRunner } from './runner.js';
import { transcodeJobs, transcodeRules, type TranscodeJobRow, type TranscodeRuleRow } from './schema.js';

// Transcode rules, the persisted job queue and the worker that drains it (one ffmpeg at a
// time). See docs/API.md "Transcode" for the replace semantics.

export type TranscodeErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT';

export class TranscodeError extends Error {
  constructor(
    readonly code: TranscodeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TranscodeError';
  }
}

type MediaFileRow = typeof mediaFiles.$inferSelect;

interface ParentInfo extends MatchableParent {
  id: number;
  rootFolderPath: string;
}

/** What the notification hook gets after a successful replace. */
export interface TranscodedNotice {
  file: MediaFileRow;
  previousPath: string;
  rule: TranscodeRule;
  sizeBefore: number;
  sizeAfter: number;
}

export interface TranscodeServiceOptions {
  db: Db;
  runner: TranscodeRunner;
  bus?: EventBus;
  log?: Logger;
  now?: () => Date;
  /** Recycle bin for replaced originals. Default: the imports module's `mediaManagement.recycleBinPath`. */
  recycleBin?: () => RecycleBin;
  /** Queue the file for media analysis (ffprobe) after a replace. */
  reanalyze?: (mediaFileId: number) => void;
  notify?: (notice: TranscodedNotice) => Promise<void> | void;
  /** How long an imported file without media info waits for analysis (runAfterImport). Default 6 h. */
  importWaitMs?: number;
  /** Per-backend limit of the hardware capability test. Default 20 s. */
  hwTestTimeoutMs?: number;
}

export interface WorkerResult {
  /** True when nothing ran because ffmpeg is missing. */
  skipped: boolean;
  completed: number;
  failed: number;
  cancelled: number;
  /** Queued jobs left for later because their rule's window is closed. */
  waiting: number;
}

interface CurrentJob {
  jobId: number;
  proc: RunningProcess | null;
  phase: 'encoding' | 'replacing';
  cancelled: boolean;
  aborted: boolean;
}

const ACTIVE: TranscodeJobStatus[] = ['queued', 'running'];

export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

/** `name.original.ext`, then `name.original_2.ext` ... */
async function uniqueSibling(path: string, suffix: string): Promise<string> {
  const ext = extname(path);
  const stem = join(dirname(path), basename(path, ext) + suffix);
  let candidate = stem + ext;
  for (let i = 2; await exists(candidate); i++) candidate = `${stem}_${i}${ext}`;
  return candidate;
}

export class TranscodeService {
  private readonly db: Db;
  private readonly runner: TranscodeRunner;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly importWaitMs: number;
  private active: Promise<WorkerResult> | null = null;
  private current: CurrentJob | null = null;
  private kicker: (() => void) | null = null;
  /** runAfterImport: imported file id -> give-up time (ms) while waiting for media info. */
  private readonly pendingImports = new Map<number, number>();
  /** Cached hardware capability test (GET /transcode/hwaccel; `refresh` runs it again). */
  private hwResult: Promise<TranscodeHwaccelResponse> | null = null;

  constructor(private readonly opts: TranscodeServiceOptions) {
    this.db = opts.db;
    this.runner = opts.runner;
    this.bus = opts.bus;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.importWaitMs = opts.importWaitMs ?? 6 * 3600_000;
  }

  get processing(): boolean {
    return this.active !== null;
  }

  /** Called after an enqueue while the worker is idle (the module starts TranscodeWorker). */
  setKicker(fn: (() => void) | null): void {
    this.kicker = fn;
  }

  private kick(): void {
    if (this.active || !this.kicker) return;
    try {
      this.kicker();
    } catch (err) {
      this.log?.warn({ err }, 'could not start the transcode worker');
    }
  }

  // -------------------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------------------

  listRules(): TranscodeRule[] {
    return this.db.select().from(transcodeRules).orderBy(asc(transcodeRules.id)).all().map(toRule);
  }

  getRule(id: number): TranscodeRule {
    const row = this.db.select().from(transcodeRules).where(eq(transcodeRules.id, id)).get();
    if (!row) throw new TranscodeError('NOT_FOUND', `transcode rule ${id} not found`);
    return toRule(row);
  }

  private validate(input: TranscodeRuleInput): void {
    try {
      validateOptions(input.action, input.options);
    } catch (err) {
      if (err instanceof TranscodeBuildError) throw new TranscodeError('VALIDATION', err.message);
      throw err;
    }
  }

  createRule(input: TranscodeRuleInput): TranscodeRule {
    this.validate(input);
    const at = this.now().toISOString();
    const row = this.db
      .insert(transcodeRules)
      .values({ ...input, createdAt: at, updatedAt: at })
      .returning()
      .get();
    return toRule(row);
  }

  updateRule(id: number, input: TranscodeRuleInput): TranscodeRule {
    this.getRule(id);
    this.validate(input);
    const row = this.db
      .update(transcodeRules)
      .set({ ...input, updatedAt: this.now().toISOString() })
      .where(eq(transcodeRules.id, id))
      .returning()
      .get();
    return toRule(row!);
  }

  /** Deletes the rule, cancels its queued jobs and detaches it from the others. */
  deleteRule(id: number): void {
    this.getRule(id);
    const at = this.now().toISOString();
    this.db.transaction((tx) => {
      tx.update(transcodeJobs)
        .set({ status: 'cancelled', message: 'rule deleted', endedAt: at })
        .where(and(eq(transcodeJobs.ruleId, id), eq(transcodeJobs.status, 'queued')))
        .run();
      tx.update(transcodeJobs).set({ ruleId: null }).where(eq(transcodeJobs.ruleId, id)).run();
      tx.delete(transcodeRules).where(eq(transcodeRules.id, id)).run();
    });
  }

  // -------------------------------------------------------------------------------------
  // Matching
  // -------------------------------------------------------------------------------------

  private parentOf(file: Pick<MediaFileRow, 'mediaType' | 'seriesId' | 'movieId'>): ParentInfo | null {
    const cols = { id: series.id, tags: series.tags, qualityProfileId: series.qualityProfileId, rootFolderPath: series.rootFolderPath };
    if (file.mediaType === 'series' && file.seriesId != null) {
      return this.db.select(cols).from(series).where(eq(series.id, file.seriesId)).get() ?? null;
    }
    if (file.mediaType === 'movie' && file.movieId != null) {
      return (
        this.db
          .select({ id: movies.id, tags: movies.tags, qualityProfileId: movies.qualityProfileId, rootFolderPath: movies.rootFolderPath })
          .from(movies)
          .where(eq(movies.id, file.movieId))
          .get() ?? null
      );
    }
    return null;
  }

  /** Whether `rule` applies to the file (media type, scope, conditions). */
  matches(rule: TranscodeRule, file: MediaFileRow, parent: ParentInfo | null = this.parentOf(file)): boolean {
    return ruleMatches(rule, { mediaType: file.mediaType, sizeBytes: file.sizeBytes, mediaInfo: file.mediaInfo ?? null }, parent);
  }

  /** Enabled rules matching the file, in id order. */
  matchingRules(mediaFileId: number): TranscodeRule[] {
    const file = this.fileOrThrow(mediaFileId);
    const parent = this.parentOf(file);
    return this.listRules().filter((r) => r.enabled && this.matches(r, file, parent));
  }

  private fileOrThrow(id: number): MediaFileRow {
    const file = this.db.select().from(mediaFiles).where(eq(mediaFiles.id, id)).get();
    if (!file) throw new TranscodeError('NOT_FOUND', `media file ${id} not found`);
    return file;
  }

  // -------------------------------------------------------------------------------------
  // Enqueue
  // -------------------------------------------------------------------------------------

  private hasActiveJob(mediaFileId: number): boolean {
    return !!this.db
      .select({ id: transcodeJobs.id })
      .from(transcodeJobs)
      .where(and(eq(transcodeJobs.mediaFileId, mediaFileId), inArray(transcodeJobs.status, ACTIVE)))
      .get();
  }

  private insertJob(file: MediaFileRow, ruleId: number, trigger: TranscodeJobTrigger): TranscodeJobRow {
    return this.db
      .insert(transcodeJobs)
      .values({ mediaFileId: file.id, ruleId, trigger, status: 'queued', progress: 0, path: file.path, command: '', queuedAt: this.now().toISOString() })
      .returning()
      .get();
  }

  /** POST /transcode/run {mediaFileId}: the first enabled matching rule, starts outside windows. */
  runForFile(mediaFileId: number): TranscodeRunResult {
    const file = this.fileOrThrow(mediaFileId);
    const rule = this.matchingRules(mediaFileId)[0];
    if (!rule) throw new TranscodeError('VALIDATION', `no enabled transcode rule matches media file ${mediaFileId}`);
    if (this.hasActiveJob(file.id)) throw new TranscodeError('CONFLICT', `media file ${mediaFileId} already has a queued or running transcode job`);
    const row = this.insertJob(file, rule.id, 'manual');
    this.kick();
    return { queued: 1, jobs: [this.getJob(row.id)] };
  }

  /**
   * POST /transcode/run {ruleId}: every library file matching the rule (the rule may be
   * disabled; asking for it by id is explicit). Files with an active job, or one this rule
   * already completed, are skipped so re-running a rule does not redo its work.
   */
  runForRule(ruleId: number): TranscodeRunResult {
    const rule = this.getRule(ruleId);
    const where = rule.mediaType === 'all' ? undefined : eq(mediaFiles.mediaType, rule.mediaType);
    const files = this.db.select().from(mediaFiles).where(where).orderBy(asc(mediaFiles.id)).all();
    const done = new Set(
      this.db
        .select({ id: transcodeJobs.mediaFileId })
        .from(transcodeJobs)
        .where(and(eq(transcodeJobs.ruleId, ruleId), eq(transcodeJobs.status, 'completed')))
        .all()
        .map((r) => r.id),
    );
    const parents = new Map<string, ParentInfo | null>();
    const ids: number[] = [];
    for (const file of files) {
      if (done.has(file.id) || this.hasActiveJob(file.id)) continue;
      const key = `${file.mediaType}:${file.seriesId ?? file.movieId}`;
      if (!parents.has(key)) parents.set(key, this.parentOf(file));
      if (!this.matches(rule, file, parents.get(key) ?? null)) continue;
      ids.push(this.insertJob(file, rule.id, 'rule').id);
    }
    if (ids.length > 0) this.kick();
    return { queued: ids.length, jobs: ids.map((id) => this.getJob(id)) };
  }

  /** Bus `import imported`: the newest file of the item is checked against runAfterImport rules. */
  onImported(mediaType: 'series' | 'movie', parentId: number): number | null {
    if (!this.listRules().some((r) => r.enabled && r.runAfterImport)) return null;
    const parent = mediaType === 'series' ? eq(mediaFiles.seriesId, parentId) : eq(mediaFiles.movieId, parentId);
    const file = this.db
      .select()
      .from(mediaFiles)
      .where(and(parent, eq(mediaFiles.mediaType, mediaType)))
      .orderBy(desc(mediaFiles.dateAdded), desc(mediaFiles.id))
      .get();
    if (!file) return null;
    if (!file.mediaInfo) {
      // Analysis runs right after the import; wait for it (`onAnalyzed`).
      this.pendingImports.set(file.id, this.now().getTime() + this.importWaitMs);
      return null;
    }
    return this.enqueueImported(file);
  }

  /** Bus `library updated` (media analysis finished): imported files waiting for media info. */
  onAnalyzed(mediaType: 'series' | 'movie', parentId: number): number[] {
    const queued: number[] = [];
    const nowMs = this.now().getTime();
    for (const [fileId, until] of this.pendingImports) {
      if (until < nowMs) {
        this.pendingImports.delete(fileId);
        continue;
      }
      const file = this.db.select().from(mediaFiles).where(eq(mediaFiles.id, fileId)).get();
      if (!file) {
        this.pendingImports.delete(fileId);
        continue;
      }
      const owner = mediaType === 'series' ? file.seriesId : file.movieId;
      if (file.mediaType !== mediaType || owner !== parentId || !file.mediaInfo) continue;
      this.pendingImports.delete(fileId);
      const id = this.enqueueImported(file);
      if (id !== null) queued.push(id);
    }
    return queued;
  }

  private enqueueImported(file: MediaFileRow): number | null {
    if (this.hasActiveJob(file.id)) return null;
    const parent = this.parentOf(file);
    const rule = this.listRules().find((r) => r.enabled && r.runAfterImport && this.matches(r, file, parent));
    if (!rule) return null;
    const row = this.insertJob(file, rule.id, 'import');
    this.kick();
    return row.id;
  }

  // -------------------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------------------

  listJobs(status?: TranscodeJobStatus, limit = 500): TranscodeJob[] {
    return this.db
      .select({ job: transcodeJobs, ruleName: transcodeRules.name })
      .from(transcodeJobs)
      .leftJoin(transcodeRules, eq(transcodeRules.id, transcodeJobs.ruleId))
      .where(status ? eq(transcodeJobs.status, status) : undefined)
      .orderBy(desc(transcodeJobs.id))
      .limit(limit)
      .all()
      .map((r) => toJob(r.job, r.ruleName ?? null));
  }

  getJob(id: number): TranscodeJob {
    const r = this.db
      .select({ job: transcodeJobs, ruleName: transcodeRules.name })
      .from(transcodeJobs)
      .leftJoin(transcodeRules, eq(transcodeRules.id, transcodeJobs.ruleId))
      .where(eq(transcodeJobs.id, id))
      .get();
    if (!r) throw new TranscodeError('NOT_FOUND', `transcode job ${id} not found`);
    return toJob(r.job, r.ruleName ?? null);
  }

  /** Queued: cancelled at once. Running: ffmpeg is killed and the temp output removed. */
  cancel(id: number): TranscodeJob {
    const job = this.getJob(id);
    const at = this.now().toISOString();
    if (job.status === 'queued') {
      this.db
        .update(transcodeJobs)
        .set({ status: 'cancelled', message: 'cancelled', endedAt: at })
        .where(and(eq(transcodeJobs.id, id), eq(transcodeJobs.status, 'queued')))
        .run();
      return this.getJob(id);
    }
    if (job.status !== 'running') throw new TranscodeError('CONFLICT', `transcode job ${id} is already ${job.status}`);
    const current = this.current;
    if (current && current.jobId === id) {
      if (current.phase === 'replacing') throw new TranscodeError('CONFLICT', `transcode job ${id} is replacing the file and can no longer be cancelled`);
      current.cancelled = true;
      current.proc?.kill();
    }
    // Not ours (left over from a crash) or being killed: either way it is cancelled now.
    this.finish(id, 'cancelled', 'cancelled');
    return this.getJob(id);
  }

  /** Rows left `running` by a crash or restart go back to the queue. */
  recoverInterrupted(): number {
    return this.db
      .update(transcodeJobs)
      .set({ status: 'queued', startedAt: null, progress: 0, command: '' })
      .where(eq(transcodeJobs.status, 'running'))
      .run().changes;
  }

  /**
   * Which backends work: each one runs a 1-frame test encode (cached until `refresh`). Tests
   * run one at a time; concurrent callers share a run.
   */
  hwaccels(opts: { refresh?: boolean } = {}): Promise<TranscodeHwaccelResponse> {
    if (opts.refresh || !this.hwResult) {
      const run = this.testHwaccels();
      this.hwResult = run;
      // A failed run is not cached.
      run.catch(() => {
        if (this.hwResult === run) this.hwResult = null;
      });
    }
    return this.hwResult;
  }

  private async testHwaccels(): Promise<TranscodeHwaccelResponse> {
    const bin = await this.runner.locate();
    if (!bin) return { ffmpegPath: null, methods: [], backends: [], results: [], testedAt: null };
    let methods: string[] = [];
    try {
      methods = parseHwaccels(await this.runner.exec(bin, ['-hide_banner', '-hwaccels']));
    } catch (err) {
      this.log?.warn({ err }, 'ffmpeg -hwaccels failed');
    }
    const results = await testBackends(this.runner, bin, methods, this.opts.hwTestTimeoutMs ? { timeoutMs: this.opts.hwTestTimeoutMs } : {});
    for (const r of results) {
      if (!r.available && methods.length > 0) this.log?.info({ backend: r.backend, reason: r.reason }, 'transcode backend unavailable');
    }
    const backends = results.filter((r) => r.available || r.backend === 'none').map((r) => r.backend);
    return { ffmpegPath: bin, methods, backends, results, testedAt: this.now().toISOString() };
  }

  settings(): TranscodeSettings {
    return getSection(this.db, 'transcode');
  }

  saveSettings(value: TranscodeSettings): TranscodeSettings {
    return setSection(this.db, 'transcode', value, this.now().toISOString());
  }

  // -------------------------------------------------------------------------------------
  // Worker
  // -------------------------------------------------------------------------------------

  /** Drain the queue one job at a time. Concurrent callers share one run. */
  process(opts: { signal?: AbortSignal } = {}): Promise<WorkerResult> {
    this.active ??= this.drain(opts.signal).finally(() => {
      this.active = null;
    });
    return this.active;
  }

  private claimNext(result: WorkerResult): TranscodeJobRow | null {
    const queued = this.db.select().from(transcodeJobs).where(eq(transcodeJobs.status, 'queued')).orderBy(asc(transcodeJobs.queuedAt), asc(transcodeJobs.id)).all();
    const at = this.now();
    const rules = new Map(this.db.select().from(transcodeRules).all().map((r) => [r.id, r]));
    result.waiting = 0;
    for (const job of queued) {
      const rule = job.ruleId != null ? rules.get(job.ruleId) : undefined;
      // Manual single-file runs start any time; rule/import jobs wait for their window.
      if (job.trigger !== 'manual' && rule && !inWindow(rule.schedule, at)) {
        result.waiting++;
        continue;
      }
      const claimed = this.db
        .update(transcodeJobs)
        .set({ status: 'running', startedAt: at.toISOString(), progress: 0 })
        .where(and(eq(transcodeJobs.id, job.id), eq(transcodeJobs.status, 'queued')))
        .run().changes;
      if (claimed) return { ...job, status: 'running', startedAt: at.toISOString() };
    }
    return null;
  }

  private async drain(signal?: AbortSignal): Promise<WorkerResult> {
    const result: WorkerResult = { skipped: false, completed: 0, failed: 0, cancelled: 0, waiting: 0 };
    const bin = await this.runner.locate();
    if (!bin) {
      result.skipped = true;
      return result;
    }
    for (;;) {
      if (signal?.aborted) break;
      const job = this.claimNext(result);
      if (!job) break;
      const status = await this.runJob(job, bin, signal);
      if (status === 'completed') result.completed++;
      else if (status === 'failed') result.failed++;
      else if (status === 'cancelled') result.cancelled++;
    }
    return result;
  }

  private finish(id: number, status: TranscodeJobStatus, message: string | null, extra: Partial<TranscodeJobRow> = {}): void {
    this.db
      .update(transcodeJobs)
      .set({ status, message: message?.slice(0, 2000) ?? null, endedAt: this.now().toISOString(), ...extra })
      .where(eq(transcodeJobs.id, id))
      .run();
  }

  /** Runs one claimed job to its end. Returns the final status, or `queued` when requeued. */
  private async runJob(job: TranscodeJobRow, bin: string, signal?: AbortSignal): Promise<TranscodeJobStatus> {
    const current: CurrentJob = { jobId: job.id, proc: null, phase: 'encoding', cancelled: false, aborted: false };
    this.current = current;
    const onAbort = () => {
      current.aborted = true;
      current.proc?.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.runClaimed(job, bin, current);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.current === current) this.current = null;
    }
  }

  private async runClaimed(job: TranscodeJobRow, bin: string, current: CurrentJob): Promise<TranscodeJobStatus> {
    const file = this.db.select().from(mediaFiles).where(eq(mediaFiles.id, job.mediaFileId)).get();
    if (!file) {
      this.finish(job.id, 'failed', 'media file no longer exists');
      return 'failed';
    }
    const ruleRow = job.ruleId != null ? this.db.select().from(transcodeRules).where(eq(transcodeRules.id, job.ruleId)).get() : undefined;
    if (!ruleRow) {
      this.finish(job.id, 'failed', 'transcode rule no longer exists');
      return 'failed';
    }
    const rule = toRule(ruleRow);
    const source = await stat(file.path).catch(() => null);
    if (!source?.isFile()) {
      this.finish(job.id, 'failed', `source file not found: ${file.path}`);
      return 'failed';
    }
    const ext = containerExtension(rule.options.container);
    const dir = dirname(file.path);
    const stem = basename(file.path, extname(file.path));
    const temp = join(dir, `.${stem}.arclight-transcode${ext}`);

    let spec: TranscodeRule = rule;
    /** Set once a hardware backend failed and the job was retried in software. */
    let fallbackNote: string | null = null;
    for (;;) {
      let args: string[];
      try {
        args = buildFfmpegArgs(file.path, temp, spec, file.mediaInfo ?? null);
      } catch (err) {
        this.finish(job.id, 'failed', err instanceof Error ? err.message : String(err));
        return 'failed';
      }
      this.db
        .update(transcodeJobs)
        .set({ command: formatCommand(bin, args), sizeBefore: source.size, path: file.path })
        .where(eq(transcodeJobs.id, job.id))
        .run();

      const parser = new FfmpegProgressParser(durationMsOf(file.mediaInfo));
      let lastPercent = -1;
      if (current.cancelled) {
        this.finish(job.id, 'cancelled', 'cancelled');
        return 'cancelled';
      }
      let proc: RunningProcess;
      try {
        proc = this.runner.start(bin, args, (chunk) => {
          for (const u of parser.push(chunk)) {
            if (u.percent === null || Math.floor(u.percent) === lastPercent) continue;
            lastPercent = Math.floor(u.percent);
            this.db
              .update(transcodeJobs)
              .set({ progress: u.percent })
              .where(and(eq(transcodeJobs.id, job.id), eq(transcodeJobs.status, 'running')))
              .run();
          }
        });
      } catch (err) {
        this.finish(job.id, 'failed', `could not start ffmpeg: ${err instanceof Error ? err.message : String(err)}`);
        return 'failed';
      }
      current.proc = proc;
      if (current.aborted) proc.kill();
      const res = await proc.done;
      current.proc = null;

      const still = this.db.select({ status: transcodeJobs.status }).from(transcodeJobs).where(eq(transcodeJobs.id, job.id)).get();
      if (current.cancelled || still?.status !== 'running') {
        await rm(temp, { force: true });
        this.finish(job.id, 'cancelled', 'cancelled');
        return 'cancelled';
      }
      if (current.aborted) {
        // Shutdown: the job goes back to the queue and restarts from scratch next time.
        await rm(temp, { force: true });
        this.db
          .update(transcodeJobs)
          .set({ status: 'queued', startedAt: null, progress: 0, command: '' })
          .where(eq(transcodeJobs.id, job.id))
          .run();
        return 'queued';
      }
      if (res.exitCode !== 0) {
        await rm(temp, { force: true });
        const hwaccel = spec.options.hwaccel;
        const usesHardware = spec.action === 'transcode' && spec.options.videoCodec !== 'copy' && hwaccel !== 'none';
        const hwReason = usesHardware ? hwInitFailure(res.stderr ?? res.stderrTail) : null;
        if (hwReason) {
          if (!this.settings().fallbackToSoftware) {
            this.finish(job.id, 'failed', hwFailureMessage(hwaccel, hwReason));
            return 'failed';
          }
          // Retry once on the software encoders (`spec` is software now, so this runs once).
          fallbackNote = hwFallbackNote(hwaccel, hwReason);
          this.log?.warn({ jobId: job.id, hwaccel, reason: hwReason }, `${HWACCEL_NAMES[hwaccel]} unavailable; retrying the transcode in software`);
          spec = { ...spec, options: softwareOptions(spec.options) };
          this.db.update(transcodeJobs).set({ progress: 0 }).where(eq(transcodeJobs.id, job.id)).run();
          continue;
        }
        const failed = `ffmpeg exited with ${res.exitCode === null ? 'a signal' : `code ${res.exitCode}`}${res.stderrTail ? `: ${res.stderrTail}` : ''}`;
        this.finish(job.id, 'failed', fallbackNote ? `${failed} (${fallbackNote})` : failed);
        return 'failed';
      }

      current.phase = 'replacing';
      try {
        await this.replace(job, file, rule, temp, ext, source.size, fallbackNote);
        return 'completed';
      } catch (err) {
        await rm(temp, { force: true });
        this.log?.warn({ err, path: file.path }, 'transcode replace failed');
        this.finish(job.id, 'failed', err instanceof Error ? err.message : String(err));
        return 'failed';
      }
    }
  }

  /**
   * Swap the finished temp file in. keepOriginal: when the result takes the original's name
   * the original becomes `<name>.original<ext>`, otherwise (container change) it stays where it
   * is, no longer tracked by the library. Otherwise the original goes to the recycle bin (or is
   * deleted when no bin is configured, like imports do).
   */
  private async replace(
    job: TranscodeJobRow,
    file: MediaFileRow,
    rule: TranscodeRule,
    temp: string,
    ext: string,
    sizeBefore: number,
    fallbackNote: string | null,
  ): Promise<void> {
    const out = await stat(temp).catch(() => null);
    if (!out || out.size === 0) throw new Error('ffmpeg produced no output');
    const sizeAfter = out.size;
    const dir = dirname(file.path);
    const stem = basename(file.path, extname(file.path));
    const finalPath = join(dir, stem + ext);
    const samePath = resolve(finalPath) === resolve(file.path);
    if (!samePath && (await exists(finalPath))) throw new Error(`destination already exists: ${finalPath}`);

    const parent = this.parentOf(file);
    let keptAt: string | null = null;
    let recycledTo: string | null = null;
    let restore: (() => Promise<void>) | null = null;
    if (rule.keepOriginal) {
      if (samePath) {
        keptAt = await uniqueSibling(file.path, '.original');
        await rename(file.path, keptAt);
        const from = keptAt;
        restore = () => rename(from, file.path);
      } else keptAt = file.path;
    } else {
      const bin = this.opts.recycleBin?.() ?? new RecycleBin(getSection(this.db, 'mediaManagement').recycleBinPath, this.now);
      recycledTo = await bin.recycle(file.path, parent ? relative(parent.rootFolderPath, dir) : '');
      const from = recycledTo;
      if (from) restore = () => rename(from, file.path);
    }
    try {
      await rename(temp, finalPath);
    } catch (err) {
      await restore?.().catch(() => undefined);
      throw err;
    }

    const relExt = extname(file.relativePath);
    const relativePath = (relExt ? file.relativePath.slice(0, -relExt.length) : file.relativePath) + ext;
    // media_info is cleared: it describes the old file until media analysis runs again.
    this.db.update(mediaFiles).set({ path: finalPath, relativePath, sizeBytes: sizeAfter, mediaInfo: null }).where(eq(mediaFiles.id, file.id)).run();
    const note = keptAt ? `original kept at ${keptAt}` : recycledTo ? `original recycled to ${recycledTo}` : 'original deleted';
    const message = `${formatSize(sizeBefore)} -> ${formatSize(sizeAfter)}; ${note}${fallbackNote ? `; ${fallbackNote}` : ''}`;
    this.finish(job.id, 'completed', message, { progress: 100, sizeAfter, sizeBefore });

    const updated = { ...file, path: finalPath, relativePath, sizeBytes: sizeAfter, mediaInfo: null };
    this.recordHistory(file, updated, rule, { sizeBefore, sizeAfter, keptAt, recycledTo, fallbackNote });
    if (parent) this.bus?.publish({ type: 'library', action: 'updated', mediaType: file.mediaType, id: parent.id });
    try {
      this.opts.reanalyze?.(file.id);
    } catch (err) {
      this.log?.warn({ err }, 'could not queue media analysis after transcode');
    }
    try {
      await this.opts.notify?.({ file: updated, previousPath: file.path, rule, sizeBefore, sizeAfter });
    } catch (err) {
      this.log?.warn({ err }, 'transcode notification failed');
    }
    this.log?.info({ jobId: job.id, from: file.path, to: finalPath }, 'file transcoded');
  }

  private recordHistory(
    before: MediaFileRow,
    after: MediaFileRow,
    rule: TranscodeRule,
    info: { sizeBefore: number; sizeAfter: number; keptAt: string | null; recycledTo: string | null; fallbackNote: string | null },
  ): void {
    const data = normalizeData({
      sourcePath: before.path,
      sourceRelativePath: before.relativePath,
      path: after.path,
      relativePath: after.relativePath,
      fileId: after.id,
      action: rule.action,
      rule: rule.name,
      sizeBefore: info.sizeBefore,
      size: info.sizeAfter,
      originalPath: info.keptAt,
      recycleBinPath: info.recycledTo,
      hardwareFallback: info.fallbackNote,
    });
    const base = {
      eventType: 'fileTranscoded' as const,
      sourceTitle: before.path,
      quality: before.quality,
      languages: before.languages,
      date: this.now().toISOString(),
      downloadId: null,
      data,
    };
    try {
      if (before.mediaType === 'movie') {
        this.db.insert(history).values({ ...base, mediaType: 'movie', seriesId: null, episodeId: null, movieId: before.movieId }).run();
      } else {
        const eps = this.db.select({ id: episodes.id }).from(episodes).where(eq(episodes.episodeFileId, before.id)).all();
        const ids: Array<number | null> = eps.length > 0 ? eps.map((e) => e.id) : [null];
        this.db
          .insert(history)
          .values(ids.map((episodeId) => ({ ...base, mediaType: 'series' as const, seriesId: before.seriesId, episodeId, movieId: null })))
          .run();
      }
      this.bus?.publish({ type: 'history', action: 'added' });
    } catch (err) {
      this.log?.warn({ err }, 'could not record transcode history');
    }
  }
}

// ---- mapping --------------------------------------------------------------------------------

export function toRule(row: TranscodeRuleRow): TranscodeRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    mediaType: row.mediaType,
    scope: row.scope,
    when: row.when,
    action: row.action,
    options: row.options,
    keepOriginal: row.keepOriginal,
    runAfterImport: row.runAfterImport,
    schedule: row.schedule ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toJob(row: TranscodeJobRow, ruleName: string | null): TranscodeJob {
  return {
    id: row.id,
    mediaFileId: row.mediaFileId,
    ruleId: row.ruleId,
    ruleName,
    trigger: row.trigger,
    status: row.status,
    progress: row.progress,
    path: row.path,
    command: row.command,
    message: row.message,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    sizeBefore: row.sizeBefore,
    sizeAfter: row.sizeAfter,
  };
}
