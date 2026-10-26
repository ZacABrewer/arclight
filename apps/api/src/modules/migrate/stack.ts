import { desc, eq } from 'drizzle-orm';
import { TransactionRollbackError } from 'drizzle-orm';
import {
  MIGRATE_SECRET_MASK,
  MigrateApplyOptions,
  MigrateSource,
  MigrateStackApplyRequest,
  MigrateStackRequest,
  MigrateSourceCleanupRequest,
  type Job,
  type MigrateApp,
  type MigrateReport,
  type MigrateReportTotals,
  type MigrateSourceCleanupResult,
  type MigrateStackApplyRequestParsed,
  type MigrateStackPreview,
  type MigrateStackSourcePlan,
  type MigrateStackSourceStatus,
  type MigrateStackStatus,
  type MigrationLogEntry,
  type MigrateProgress,
  type MigrateRunState,
  type MigrateBackupRef,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import type { Scheduler } from '../../scheduler.js';
import { adoptedHashes, cleanupSourceTorrents } from './areas-torrents.js';
import { MigrateError } from './errors.js';
import { APP_NAMES } from './readers.js';
import { migrateRuns, type MigrateRunRow } from './schema.js';
import { AREA_LABELS, describeSource, maskSource, sourceInstance, type ApplyRun, type MigrateService } from './service.js';
import type { SourceBundle } from './types.js';

// The whole-stack import ("Import your existing stack"): preview every source, then one
// `MigrateStack` job that takes an Arclight backup, imports the sources in dependency order
// (Prowlarr, Sonarr, Radarr, qBittorrent, Bazarr, Seerr) and writes a final report.
//
// Runs are persisted in `migrate_runs` (request with secrets, per-source status, log), so a
// real run that failed or was cut short by a restart can be resumed: completed sources are
// skipped and the rest re-run, and everything already imported is skipped through
// `migrate_imported`, so nothing is duplicated.
//
// A dry run reads every source first and then runs all database areas of all sources inside one
// transaction that is rolled back, so later sources see what earlier ones would have created
// (Seerr requests find the series Sonarr would add). Torrent adoption is only checked.

export const MIGRATE_STACK_JOB = 'MigrateStack';

/** Import order of the apps: what is referenced comes first. */
export const STACK_ORDER: readonly MigrateApp[] = ['prowlarr', 'sonarr', 'radarr', 'qbittorrent', 'bazarr', 'seerr'];

const LOG_LIMIT = 3000;

interface LiveRun {
  runId: number;
  jobId: number | null;
  request: MigrateStackApplyRequestParsed;
  state: MigrateRunState;
  startedAt: string;
  endedAt: string | null;
  backup: MigrateBackupRef | null;
  sources: MigrateStackSourceStatus[];
  current: number | null;
  progress: MigrateProgress | null;
  log: MigrationLogEntry[];
  error: string | null;
}

/** Display labels: the given label, else the app name, numbered when an app appears twice. */
export function sourceLabels(sources: ReadonlyArray<Pick<MigrateSource, 'app' | 'label'>>): string[] {
  const seen = new Map<MigrateApp, number>();
  const totals = new Map<MigrateApp, number>();
  for (const s of sources) if (!s.label) totals.set(s.app, (totals.get(s.app) ?? 0) + 1);
  return sources.map((s) => {
    if (s.label) return s.label;
    const n = (seen.get(s.app) ?? 0) + 1;
    seen.set(s.app, n);
    return (totals.get(s.app) ?? 1) > 1 ? `${APP_NAMES[s.app]} ${n}` : APP_NAMES[s.app];
  });
}

/** Indices of `sources` in import order (stable for several instances of one app). */
export function stackOrder(sources: ReadonlyArray<Pick<MigrateSource, 'app'>>): number[] {
  return sources.map((s, i) => ({ i, rank: STACK_ORDER.indexOf(s.app) })).sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.i);
}

const PROWLARR_SYNCED = /\/\d+\/?$/;

/**
 * When the stack also imports Prowlarr, the indexers Prowlarr pushed into Sonarr/Radarr
 * (Torznab/Newznab entries pointing at `<prowlarr>/<id>/`) are duplicates of what comes from
 * Prowlarr itself, so they are marked unsupported with that reason.
 */
export function markProwlarrSynced(bundle: SourceBundle): number {
  if (bundle.app !== 'sonarr' && bundle.app !== 'radarr') return 0;
  let marked = 0;
  for (const item of bundle.areas.indexers?.items ?? []) {
    if (item.unsupported) continue;
    const url = item.payload.create.settings.baseUrl ?? '';
    if (/\(prowlarr\)\s*$/i.test(item.name) || PROWLARR_SYNCED.test(url.replace(/\/api\/?$/, ''))) {
      item.unsupported = 'added by Prowlarr; it is imported from Prowlarr itself';
      marked++;
    }
  }
  return marked;
}

export class MigrateStackRunner {
  private live: LiveRun | null = null;
  private scheduler: Scheduler | undefined;

  constructor(private readonly service: MigrateService) {}

  private get db(): Db {
    return this.service.db;
  }

  private iso(): string {
    return this.service.now().toISOString();
  }

  registerScheduler(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  /** Runs that were `running` when the process stopped become `interrupted` (resumable). */
  recoverInterrupted(): void {
    this.db.update(migrateRuns).set({ state: 'interrupted', endedAt: this.iso(), error: 'Arclight stopped while the import was running' }).where(eq(migrateRuns.state, 'running')).run();
  }

  // ---- preview -----------------------------------------------------------------------------

  async preview(input: MigrateStackRequest): Promise<MigrateStackPreview> {
    const req = MigrateStackRequest.parse(input);
    const labels = sourceLabels(req.sources);
    const hasProwlarr = req.sources.some((s) => s.app === 'prowlarr');
    const out: MigrateStackSourcePlan[] = req.sources.map((s, i) => ({ key: String(i), app: s.app, label: labels[i]!, plan: null, error: null }));
    for (const i of stackOrder(req.sources)) {
      const source = req.sources[i]!;
      try {
        const bundle = await this.service.readBundle(source);
        if (hasProwlarr) markProwlarrSynced(bundle);
        out[i]!.plan = this.service.planBundle(source, bundle);
      } catch (err) {
        out[i]!.error = err instanceof Error ? err.message : String(err);
      }
    }
    return { sources: out, createdAt: this.iso() };
  }

  // ---- status ------------------------------------------------------------------------------

  private lastRow(): MigrateRunRow | undefined {
    return this.db.select().from(migrateRuns).orderBy(desc(migrateRuns.id)).limit(1).get();
  }

  private row(id: number): MigrateRunRow | undefined {
    return this.db.select().from(migrateRuns).where(eq(migrateRuns.id, id)).get();
  }

  private qbittorrentAdopted(): { source: MigrateSource; hashes: string[] }[] {
    const realRuns = this.db.select().from(migrateRuns).orderBy(desc(migrateRuns.id)).all().filter((r) => !r.dryRun);
    const seen = new Set<string>();
    const out: { source: MigrateSource; hashes: string[] }[] = [];
    for (const run of realRuns) {
      for (const sel of run.request.sources) {
        if (sel.source.app !== 'qbittorrent') continue;
        const instance = sourceInstance(sel.source);
        if (seen.has(instance)) continue;
        seen.add(instance);
        const hashes = adoptedHashes(this.db, instance);
        if (hashes.length > 0) out.push({ source: sel.source, hashes });
      }
    }
    return out;
  }

  status(): MigrateStackStatus {
    const adoptedTorrents = this.qbittorrentAdopted().reduce((n, s) => n + s.hashes.length, 0);
    const live = this.live;
    if (live) {
      return {
        state: live.state,
        runId: live.runId,
        jobId: live.jobId,
        dryRun: live.request.dryRun,
        startedAt: live.startedAt,
        endedAt: live.endedAt,
        backup: live.backup,
        sources: live.sources.map((s) => ({ ...s })),
        current: live.current,
        progress: live.progress,
        log: [...live.log],
        error: live.error,
        resumable: this.resumable(live.state, live.request.dryRun),
        adoptedTorrents,
      };
    }
    const row = this.lastRow();
    if (!row) {
      return { state: 'idle', runId: null, jobId: null, dryRun: true, startedAt: null, endedAt: null, backup: null, sources: [], current: null, progress: null, log: [], error: null, resumable: false, adoptedTorrents };
    }
    return {
      state: row.state,
      runId: row.id,
      jobId: null,
      dryRun: row.dryRun,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      backup: row.backup ?? null,
      sources: row.sources,
      current: null,
      progress: null,
      log: row.log,
      error: row.error,
      resumable: this.resumable(row.state, row.dryRun),
      adoptedTorrents,
    };
  }

  private resumable(state: MigrateRunState, dryRun: boolean): boolean {
    return !dryRun && (state === 'failed' || state === 'interrupted');
  }

  // ---- report ------------------------------------------------------------------------------

  report(runId?: number): MigrateReport {
    const row = runId !== undefined ? this.row(runId) : this.lastRow();
    if (!row) throw new MigrateError('NOT_FOUND', 'no import has been run yet');
    const live = this.live && this.live.runId === row.id ? this.live : null;
    const sources = live ? live.sources : row.sources;
    const totals: MigrateReportTotals = { created: 0, updated: 0, skipped: 0, staged: 0, failed: 0 };
    for (const s of sources) {
      for (const a of s.result?.areas ?? []) {
        totals.created += a.created;
        totals.updated += a.updated;
        totals.skipped += a.skipped;
        totals.staged += a.staged;
        totals.failed += a.failed;
      }
    }
    return {
      version: 1,
      runId: row.id,
      state: live ? live.state : row.state,
      dryRun: row.dryRun,
      startedAt: row.startedAt,
      endedAt: live ? live.endedAt : row.endedAt,
      backup: (live ? live.backup : row.backup) ?? null,
      request: { ...row.request, sources: row.request.sources.map((s) => ({ ...s, source: maskSource(s.source) })) },
      sources,
      totals,
      log: live ? live.log : row.log,
    };
  }

  // ---- start / resume ----------------------------------------------------------------------

  private assertIdle(): void {
    if (this.live?.state === 'running' || this.service.status().state === 'running') throw new MigrateError('BUSY', 'an import is already running');
  }

  start(input: MigrateStackApplyRequest): MigrateStackStatus {
    this.assertIdle();
    const request = MigrateStackApplyRequest.parse(input);
    for (const s of request.sources) {
      if (s.source.apiKey === MIGRATE_SECRET_MASK || s.source.password === MIGRATE_SECRET_MASK) {
        throw new MigrateError('VALIDATION', 'the request carries a masked secret; send the real API key or password');
      }
    }
    return this.launch(request, null);
  }

  resume(): MigrateStackStatus {
    this.assertIdle();
    const row = this.lastRow();
    if (!row || !this.resumable(row.state, row.dryRun)) throw new MigrateError('VALIDATION', 'there is no failed or interrupted import to resume');
    return this.launch(row.request, row);
  }

  private launch(request: MigrateStackApplyRequestParsed, previous: MigrateRunRow | null): MigrateStackStatus {
    const labels = sourceLabels(request.sources.map((s) => s.source));
    const startedAt = this.iso();
    const sources: MigrateStackSourceStatus[] = request.sources.map((sel, i) => {
      const prior = previous?.sources[i];
      if (prior && prior.state === 'completed') return { ...prior };
      return { key: String(i), app: sel.source.app, label: labels[i]!, mode: sel.source.mode, state: 'pending', result: null, error: null };
    });
    const inserted = this.db
      .insert(migrateRuns)
      .values({ state: 'running', dryRun: request.dryRun, request, sources, backup: null, log: [], error: null, startedAt, endedAt: null })
      .returning({ id: migrateRuns.id })
      .get();
    if (previous) this.db.update(migrateRuns).set({ state: 'failed', error: `resumed as run ${inserted.id}` }).where(eq(migrateRuns.id, previous.id)).run();
    this.live = { runId: inserted.id, jobId: null, request, state: 'running', startedAt, endedAt: null, backup: previous?.backup ?? null, sources, current: null, progress: null, log: [], error: null };
    const live = this.live;
    if (previous) this.addLog(live, 'info', `Resuming run ${previous.id}: completed sources are kept, the rest re-run (already imported items are skipped)`);

    const handler = async (): Promise<string> => this.run(live);
    if (this.scheduler) {
      const { job, done } = this.scheduler.runTask(MIGRATE_STACK_JOB, 'manual', handler);
      live.jobId = job.id;
      void done.then((j) => {
        if (j.status !== 'completed' && live.state === 'running') this.finish(live, 'failed', j.message ?? 'the import job stopped');
      });
    } else {
      void this.run(live).catch((err: unknown) => this.finish(live, 'failed', err instanceof Error ? err.message : String(err)));
    }
    return this.status();
  }

  private addLog(live: LiveRun, level: MigrationLogEntry['level'], message: string, area: MigrationLogEntry['area'] = null): void {
    live.log.push({ time: this.iso(), level, area, message });
    if (live.log.length > LOG_LIMIT) live.log.splice(0, live.log.length - LOG_LIMIT);
  }

  private persist(live: LiveRun): void {
    this.db
      .update(migrateRuns)
      .set({ state: live.state, sources: live.sources, backup: live.backup, log: live.log, error: live.error, endedAt: live.endedAt })
      .where(eq(migrateRuns.id, live.runId))
      .run();
  }

  private finish(live: LiveRun, state: MigrateRunState, error: string | null): void {
    live.state = state;
    live.error = error;
    live.endedAt = this.iso();
    live.current = null;
    live.progress = null;
    if (error) this.addLog(live, 'error', error);
    this.persist(live);
  }

  private optionsFor(live: LiveRun, areas: MigrateStackApplyRequestParsed['sources'][number]['areas']): MigrateApplyOptions {
    const r = live.request;
    return MigrateApplyOptions.parse({ areas, conflictPolicy: r.conflictPolicy, areaPolicies: r.areaPolicies, dryRun: r.dryRun, torrents: r.torrents });
  }

  private hooks(live: LiveRun, index: number, job: Job | null) {
    return {
      onProgress: (p: MigrateProgress) => {
        live.current = index;
        live.progress = p;
        this.service.publishJob(job, `${live.sources[index]?.label ?? ''}: ${AREA_LABELS[p.area]} ${p.done}/${p.total}`);
      },
      onLog: (entry: MigrationLogEntry) => {
        live.log.push({ ...entry, message: `${live.sources[index]?.label ?? ''}: ${entry.message}` });
        if (live.log.length > LOG_LIMIT) live.log.splice(0, live.log.length - LOG_LIMIT);
      },
    };
  }

  /** The job body. */
  private async run(live: LiveRun): Promise<string> {
    const job = live.jobId !== null ? this.service.currentJob(MIGRATE_STACK_JOB) : null;
    const request = live.request;
    const order = stackOrder(request.sources.map((s) => s.source));
    const hasProwlarr = request.sources.some((s) => s.source.app === 'prowlarr');
    this.addLog(live, 'info', `${request.dryRun ? 'Dry run' : 'Import'} of ${request.sources.length} source(s): ${order.map((i) => live.sources[i]!.label).join(', ')}`);

    try {
      if (!request.dryRun && request.backup && !live.backup) {
        if (!this.service.deps.createBackup) {
          this.addLog(live, 'warn', 'No backup service is available; continuing without an automatic backup');
        } else {
          this.addLog(live, 'info', 'Taking an Arclight backup before importing');
          // A failed backup stops the run: nothing has been written yet.
          live.backup = await this.service.deps.createBackup();
          this.addLog(live, 'info', `Backup ${live.backup.name} created; restore it from System > Backups to undo this import`);
          this.persist(live);
        }
      }

      if (request.dryRun) await this.runDry(live, order, hasProwlarr, job);
      else await this.runReal(live, order, hasProwlarr, job);

      const failedSources = live.sources.filter((s) => s.state === 'failed').length;
      const failedItems = live.sources.reduce((n, s) => n + (s.result?.areas.reduce((m, a) => m + a.failed, 0) ?? 0), 0);
      const state: MigrateRunState = failedSources > 0 ? 'failed' : 'completed';
      this.finish(live, state, failedSources > 0 ? `${failedSources} source(s) failed; see the log` : null);
      const created = live.sources.reduce((n, s) => n + (s.result?.areas.reduce((m, a) => m + a.created, 0) ?? 0), 0);
      return `${request.dryRun ? 'dry run: ' : ''}${created} created, ${failedItems} failed`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.finish(live, 'failed', message);
      throw err;
    }
  }

  private async readFor(live: LiveRun, index: number, hasProwlarr: boolean): Promise<SourceBundle | null> {
    const sel = live.request.sources[index]!;
    const status = live.sources[index]!;
    try {
      this.addLog(live, 'info', `${status.label}: reading ${sel.source.mode === 'api' ? 'through the API' : 'files'} (${describeSource(sel.source)})`);
      const bundle = await this.service.readBundle(MigrateSource.parse(sel.source));
      if (hasProwlarr) {
        const marked = markProwlarrSynced(bundle);
        if (marked > 0) this.addLog(live, 'info', `${status.label}: ${marked} indexer(s) were added by Prowlarr and are imported from Prowlarr instead`);
      }
      return bundle;
    } catch (err) {
      status.state = 'failed';
      status.error = err instanceof Error ? err.message : String(err);
      this.addLog(live, 'error', `${status.label}: ${status.error}`);
      this.persist(live);
      return null;
    }
  }

  private async runReal(live: LiveRun, order: number[], hasProwlarr: boolean, job: Job | null): Promise<void> {
    for (const i of order) {
      const status = live.sources[i]!;
      if (status.state === 'completed') {
        this.addLog(live, 'info', `${status.label}: already imported by the earlier run, skipped`);
        continue;
      }
      live.current = i;
      status.state = 'running';
      status.error = null;
      this.persist(live);
      const bundle = await this.readFor(live, i, hasProwlarr);
      if (!bundle) continue;
      const sel = live.request.sources[i]!;
      try {
        const run = this.service.beginRun(MigrateSource.parse(sel.source), bundle, this.optionsFor(live, sel.areas), this.hooks(live, i, job));
        await this.service.applySyncYielding(run);
        await this.service.applyAsync(run);
        status.result = this.service.finishRun(run);
        status.state = 'completed';
      } catch (err) {
        status.state = 'failed';
        status.error = err instanceof Error ? err.message : String(err);
        this.addLog(live, 'error', `${status.label}: ${status.error}`);
      }
      this.persist(live);
    }
  }

  private async runDry(live: LiveRun, order: number[], hasProwlarr: boolean, job: Job | null): Promise<void> {
    const runs = new Map<number, ApplyRun>();
    for (const i of order) {
      live.current = i;
      live.sources[i]!.state = 'running';
      const bundle = await this.readFor(live, i, hasProwlarr);
      if (!bundle) continue;
      const sel = live.request.sources[i]!;
      runs.set(i, this.service.beginRun(MigrateSource.parse(sel.source), bundle, this.optionsFor(live, sel.areas), this.hooks(live, i, job)));
    }
    this.addLog(live, 'info', 'Checking every source against Arclight in one transaction that is rolled back');
    try {
      this.db.transaction((tx) => {
        for (const i of order) {
          const run = runs.get(i);
          if (run) this.service.applySync(run, tx as unknown as Db);
        }
        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
    for (const i of order) {
      const run = runs.get(i);
      const status = live.sources[i]!;
      if (!run) continue;
      try {
        await this.service.applyAsync(run);
        status.result = this.service.finishRun(run);
        status.state = 'completed';
      } catch (err) {
        status.state = 'failed';
        status.error = err instanceof Error ? err.message : String(err);
      }
      this.persist(live);
    }
  }

  // ---- optional qBittorrent clean-up ---------------------------------------------------------

  async cleanup(input: MigrateSourceCleanupRequest): Promise<MigrateSourceCleanupResult> {
    const req = MigrateSourceCleanupRequest.parse(input);
    this.assertIdle();
    const targets = this.qbittorrentAdopted();
    if (targets.length === 0) throw new MigrateError('VALIDATION', 'no torrents were adopted from qBittorrent');
    const result: MigrateSourceCleanupResult = { action: req.action, done: 0, failed: [] };
    for (const t of targets) {
      const r = await cleanupSourceTorrents(MigrateSource.parse(t.source), t.hashes, req.action, this.service.deps);
      result.done += r.done;
      result.failed.push(...r.failed);
    }
    return result;
  }
}
