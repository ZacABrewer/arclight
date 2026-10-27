import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { TransactionRollbackError } from 'drizzle-orm';
import pino, { type Logger } from 'pino';
import {
  MIGRATE_SECRET_MASK,
  MigrateApplyOptions,
  MigrateSource,
  type Job,
  type MigrateApplyOptionsInput,
  type MigrateArea,
  type MigrateSourceCandidate,
  type MigrateSourceInput,
  type MigrateStatus,
  type MigrationAreaPlan,
  type MigrationAreaResult,
  type MigrationConflict,
  type MigrationItemOutcome,
  type MigrationLogEntry,
  type MigrationPlan,
  type MigrationResult,
  type MigrationUnsupported,
  type MigrationWarning,
  type MigrateProgress,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { jobs } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import type { Scheduler } from '../../scheduler.js';
import { createServices, importedTarget, SkipItem, type AreaEnv } from './areas.js';
import type { MigrateDeps } from './deps.js';
import { MigrateError } from './errors.js';
import { asyncHandler, syncHandler } from './handlers.js';
import { readSource } from './readers.js';
import { migrateImported, migrateStaging } from './schema.js';
import { detectSources, type DetectOptions } from './sources.js';
import type { AreaPayloads, SourceBundle, SourceItem } from './types.js';

// Plans and applies an adoption import of one source. `plan` reads the source and compares it
// with the current database without writing. `apply` re-reads the source and writes area by
// area, each area in its own transaction (each item in a savepoint, so one bad row does not
// undo its area); areas that need I/O beyond the database (torrents) run after the others,
// outside any transaction. A dry run wraps the database areas in one transaction that is
// rolled back and lets the I/O areas only check what they would do. Imported upstream ids are
// remembered in `migrate_imported`, so re-running skips them; existing Arclight rows are never
// deleted, only skipped, overwritten or merged per the area's conflict policy.
// The whole-stack runner (stack.ts) builds on `readBundle`, `applySync` and `applyAsync`.

export const MIGRATE_JOB = 'MigrateFromArr';

/** Dependency-safe order: things referenced before the things that reference them. */
export const AREA_ORDER: readonly MigrateArea[] = [
  'tags',
  'rootFolders',
  'customFormats',
  'qualityProfiles',
  'delayProfiles',
  'downloadClients',
  'indexerProxies',
  'indexers',
  'releaseProfiles',
  'remotePathMappings',
  'notifications',
  'importLists',
  'naming',
  'mediaManagement',
  'series',
  'movies',
  'collections',
  'history',
  'blocklist',
  'applications',
  'subtitleProfiles',
  'subtitleAssignments',
  'subtitleProviders',
  'subtitleFiles',
  'subtitleHistory',
  'users',
  'requestSettings',
  'requests',
  'issues',
  'torrents',
];

export const AREA_LABELS: Record<MigrateArea, string> = {
  tags: 'Tags',
  rootFolders: 'Root folders',
  customFormats: 'Custom formats',
  qualityProfiles: 'Quality profiles',
  delayProfiles: 'Delay profiles',
  releaseProfiles: 'Release profiles',
  indexers: 'Indexers',
  indexerProxies: 'Indexer proxies',
  applications: 'Applications (report only)',
  downloadClients: 'Download clients',
  remotePathMappings: 'Remote path mappings',
  notifications: 'Notifications',
  importLists: 'Import lists',
  naming: 'Naming',
  mediaManagement: 'Media management',
  series: 'Series',
  movies: 'Movies',
  collections: 'Collections',
  history: 'History',
  blocklist: 'Blocklist',
  subtitleProfiles: 'Subtitle language profiles',
  subtitleAssignments: 'Subtitle profile assignments',
  subtitleProviders: 'Subtitle providers',
  subtitleFiles: 'Existing subtitle files',
  subtitleHistory: 'Subtitle history and blacklist',
  users: 'Users',
  requests: 'Requests',
  issues: 'Issues',
  requestSettings: 'Request settings',
  torrents: 'Torrents',
};

const LOG_LIMIT = 1000;
const PROGRESS_EVERY = 25;
/** Per-item outcomes kept in a result (for the downloadable report). */
const ITEMS_LIMIT = 5000;

export interface MigrateServiceOptions {
  db: Db;
  log?: Logger;
  bus?: EventBus;
  now?: () => Date;
  detect?: DetectOptions;
  deps?: MigrateDeps;
}

export interface ApplyHooks {
  onProgress?: (progress: MigrateProgress) => void;
  onLog?: (entry: MigrationLogEntry) => void;
}

type ApplyRequest = MigrateSource & { options: MigrateApplyOptions };
type LogFn = (level: MigrationLogEntry['level'], area: MigrateArea | null, message: string) => void;

/** Running totals of one source while its areas are applied (sync part, then async part). */
export interface ApplyRun {
  source: MigrateSource;
  bundle: SourceBundle;
  options: MigrateApplyOptions;
  instance: string;
  selected: MigrateArea[];
  idMap: Map<string, number>;
  results: MigrationAreaResult[];
  warnings: MigrationWarning[];
  items: MigrationItemOutcome[];
  startedAt: string;
  log: LogFn;
  warn: (area: MigrateArea, message: string, sourceId?: string) => void;
  hooks: ApplyHooks;
}

/** Stable id of a source installation: app + database path (files) or app + URL (API). */
export function sourceInstance(source: Pick<MigrateSource, 'app' | 'dbPath'> & Partial<Pick<MigrateSource, 'mode' | 'url'>>): string {
  const where = source.mode === 'api' && source.url ? `api:${source.url.trim().replace(/\/+$/, '').toLowerCase()}` : resolve(source.dbPath ?? '').toLowerCase();
  return createHash('sha1').update(`${source.app}|${where}`).digest('hex').slice(0, 16);
}

/** The source with its API key and password masked, for responses and logs. */
export function maskSource<T extends { apiKey?: string | undefined; password?: string | undefined }>(source: T): T {
  const out = { ...source };
  if (out.apiKey) out.apiKey = MIGRATE_SECRET_MASK;
  if (out.password) out.password = MIGRATE_SECRET_MASK;
  return out;
}

/** Where a source is, for log lines (never includes secrets). */
export function describeSource(source: MigrateSource): string {
  return source.mode === 'api' ? (source.url ?? '?') : (source.dbPath ?? '?');
}

function isPlan(v: unknown): v is MigrationPlan {
  return !!v && typeof v === 'object' && 'source' in v && 'areas' in v;
}

function idleStatus(): MigrateStatus {
  return { state: 'idle', app: null, jobId: null, startedAt: null, endedAt: null, progress: null, log: [], result: null, error: null };
}

export class MigrateService {
  readonly db: Db;
  readonly log: Logger;
  private readonly bus: EventBus | undefined;
  readonly now: () => Date;
  private readonly detectOptions: DetectOptions;
  readonly deps: MigrateDeps;
  private state: MigrateStatus = idleStatus();
  private pending: ApplyRequest | null = null;
  private scheduler: Scheduler | undefined;

  constructor(opts: MigrateServiceOptions) {
    this.db = opts.db;
    this.log = opts.log ?? pino({ level: 'silent' });
    this.bus = opts.bus;
    this.now = opts.now ?? (() => new Date());
    this.detectOptions = opts.detect ?? {};
    this.deps = opts.deps ?? {};
  }

  // ---- sources ---------------------------------------------------------------------------

  sources(): MigrateSourceCandidate[] {
    return detectSources(this.detectOptions);
  }

  async readBundle(source: MigrateSource): Promise<SourceBundle> {
    return readSource(source, this.deps);
  }

  // ---- plan ------------------------------------------------------------------------------

  async plan(input: MigrateSourceInput, bundleIn?: SourceBundle): Promise<MigrationPlan> {
    const source = MigrateSource.parse(input);
    const bundle = bundleIn ?? (await this.readBundle(source));
    return this.planBundle(source, bundle);
  }

  /** Compares a bundle with the current database (nothing is written). */
  planBundle(source: MigrateSource, bundle: SourceBundle, db: Db = this.db): MigrationPlan {
    const instance = sourceInstance(source);
    const options = MigrateApplyOptions.parse({});
    const env = this.env(db, bundle, source, instance, options, 'skip', new Map(), () => undefined, true);
    const areas: MigrationAreaPlan[] = [];
    const conflicts: MigrationConflict[] = [];
    const unsupported: MigrationUnsupported[] = [];

    for (const area of AREA_ORDER) {
      const ab = bundle.areas[area];
      if (!ab) continue;
      const row: MigrationAreaPlan = { area, label: AREA_LABELS[area], mode: ab.mode, total: ab.items.length, create: 0, conflicts: 0, alreadyImported: 0, unsupported: 0, details: { ...(ab.details ?? {}) } };
      const handler = syncHandler(area) ?? asyncHandler(area);
      for (const item of ab.items as SourceItem<AreaPayloads[MigrateArea]>[]) {
        if (ab.mode === 'report') continue;
        if (item.unsupported) {
          row.unsupported++;
          unsupported.push({ area, sourceId: item.sourceId, name: item.name, reason: item.unsupported });
          continue;
        }
        if (item.stageArea) {
          if (this.stagedRow(db, item.stageArea, bundle.app, item.sourceId)) row.alreadyImported++;
          else row.create++;
          continue;
        }
        if (importedTarget(db, instance, area, item.sourceId)) {
          row.alreadyImported++;
          continue;
        }
        let existing: ReturnType<NonNullable<typeof handler>['find']> = null;
        try {
          existing = handler?.find(env, item) ?? null;
        } catch {
          existing = null;
        }
        if (existing) {
          row.conflicts++;
          conflicts.push({ area, sourceId: item.sourceId, name: item.name, existingId: existing.id, reason: existing.reason });
        } else row.create++;
      }
      areas.push(row);
    }
    let extras: Pick<MigrationPlan, 'torrentCategories' | 'torrentEngineRunning'> = {};
    try {
      extras = bundle.planExtras?.(env) ?? {};
    } catch (err) {
      this.log.warn({ err }, 'plan extras failed');
    }
    return {
      source: maskSource(source),
      app: source.app,
      schemaVersion: bundle.schemaVersion,
      areas,
      warnings: bundle.warnings,
      conflicts,
      unsupported,
      ...extras,
      createdAt: this.now().toISOString(),
    };
  }

  // ---- apply -----------------------------------------------------------------------------

  async apply(planOrSource: MigrationPlan | MigrateSourceInput, optionsInput: MigrateApplyOptionsInput = {}, hooks: ApplyHooks = {}): Promise<MigrationResult> {
    const source = MigrateSource.parse(isPlan(planOrSource) ? planOrSource.source : planOrSource);
    const options = MigrateApplyOptions.parse(optionsInput);
    const bundle = await this.readBundle(source);
    const run = this.beginRun(source, bundle, options, hooks);
    run.log('info', null, `${options.dryRun ? 'Dry run: ' : ''}importing ${run.selected.length} area(s) from ${source.app} (${describeSource(source)}), conflicts: ${options.conflictPolicy}`);
    if (options.dryRun) {
      try {
        this.db.transaction((tx) => {
          this.applySync(run, tx as unknown as Db);
          tx.rollback();
        });
      } catch (err) {
        if (!(err instanceof TransactionRollbackError)) throw err;
      }
    } else {
      await this.applySyncYielding(run);
    }
    await this.applyAsync(run);
    return this.finishRun(run);
  }

  /** Sets up the bookkeeping for applying one bundle. */
  beginRun(source: MigrateSource, bundle: SourceBundle, options: MigrateApplyOptions, hooks: ApplyHooks): ApplyRun {
    const selected = AREA_ORDER.filter((a) => bundle.areas[a] && (options.areas.length === 0 || options.areas.includes(a)));
    const warnings: MigrationWarning[] = [...bundle.warnings.filter((w) => selected.includes(w.area))];
    const log: LogFn = (level, area, message) => {
      const entry: MigrationLogEntry = { time: this.now().toISOString(), level, area, message };
      hooks.onLog?.(entry);
      this.log[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info']({ area, app: source.app }, message);
    };
    const warn = (area: MigrateArea, message: string, sourceId?: string) => {
      warnings.push(sourceId === undefined ? { area, message } : { area, message, sourceId });
      log('warn', area, message);
    };
    return {
      source,
      bundle,
      options,
      instance: sourceInstance(source),
      selected,
      idMap: new Map(),
      results: [],
      warnings,
      items: [],
      startedAt: this.now().toISOString(),
      log,
      warn,
      hooks,
    };
  }

  private syncAreas(run: ApplyRun): MigrateArea[] {
    return run.selected.filter((a) => !asyncHandler(a));
  }

  private asyncAreas(run: ApplyRun): MigrateArea[] {
    return run.selected.filter((a) => !!asyncHandler(a));
  }

  /** Applies the database areas inside `db` (a transaction for dry runs) without yielding. */
  applySync(run: ApplyRun, db: Db): void {
    const areas = this.syncAreas(run);
    for (const area of areas) {
      const index = run.selected.indexOf(area);
      try {
        run.results.push(db.transaction((areaTx) => this.applyArea(this.runEnv(run, areaTx as unknown as Db, area), area, index, run)));
      } catch (err) {
        run.results.push(this.failedArea(area, run, err));
      }
    }
  }

  /** Applies the database areas one transaction each, yielding to the event loop between areas. */
  async applySyncYielding(run: ApplyRun): Promise<void> {
    for (const area of this.syncAreas(run)) {
      const index = run.selected.indexOf(area);
      try {
        // A drizzle transaction object exposes the same query API as the database handle;
        // services take a `Db`, so the transaction is handed to them under that type.
        run.results.push(this.db.transaction((tx) => this.applyArea(this.runEnv(run, tx as unknown as Db, area), area, index, run)));
      } catch (err) {
        run.results.push(this.failedArea(area, run, err));
      }
      // Let status requests and bus deliveries through between areas.
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  /** Applies the I/O areas (torrents) item by item, outside any transaction. */
  async applyAsync(run: ApplyRun): Promise<void> {
    for (const area of this.asyncAreas(run)) {
      const index = run.selected.indexOf(area);
      try {
        run.results.push(await this.applyAsyncArea(this.runEnv(run, this.db, area), area, index, run));
      } catch (err) {
        run.results.push(this.failedArea(area, run, err));
      }
    }
  }

  finishRun(run: ApplyRun): MigrationResult {
    const order = (a: MigrateArea) => run.selected.indexOf(a);
    const areas = [...run.results].sort((a, b) => order(a.area) - order(b.area));
    const totals = areas.reduce((acc, r) => ({ created: acc.created + r.created, updated: acc.updated + r.updated, staged: acc.staged + r.staged, failed: acc.failed + r.failed }), { created: 0, updated: 0, staged: 0, failed: 0 });
    run.log('info', null, `${run.options.dryRun ? 'Dry run finished (nothing saved)' : 'Import finished'}: ${totals.created} created, ${totals.updated} updated, ${totals.staged} staged, ${totals.failed} failed`);
    return { app: run.source.app, dryRun: run.options.dryRun, areas, warnings: run.warnings, items: run.items, startedAt: run.startedAt, endedAt: this.now().toISOString() };
  }

  private failedArea(area: MigrateArea, run: ApplyRun, err: unknown): MigrationAreaResult {
    run.log('error', area, `area failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
    return { area, created: 0, updated: 0, skipped: 0, staged: 0, failed: run.bundle.areas[area]?.items.length ?? 0 };
  }

  private runEnv(run: ApplyRun, db: Db, area: MigrateArea): AreaEnv {
    const policy = run.options.areaPolicies[area] ?? run.options.conflictPolicy;
    return this.env(db, run.bundle, run.source, run.instance, run.options, policy, run.idMap, run.warn, run.options.dryRun);
  }

  env(
    db: Db,
    bundle: SourceBundle,
    source: MigrateSource,
    instance: string,
    options: MigrateApplyOptions,
    policy: MigrateApplyOptions['conflictPolicy'],
    idMap: Map<string, number>,
    warn: AreaEnv['warn'],
    dryRun: boolean,
  ): AreaEnv {
    return {
      db,
      app: bundle.app,
      instance,
      bundle,
      policy,
      now: this.now().toISOString(),
      log: this.log,
      idMap,
      warn,
      services: createServices(db, this.log),
      dryRun,
      source,
      options,
      deps: this.deps,
    };
  }

  private note(run: ApplyRun, area: MigrateArea, item: SourceItem<unknown>, outcome: MigrationItemOutcome['outcome'], message?: string): void {
    if (run.items.length >= ITEMS_LIMIT) return;
    run.items.push(message === undefined ? { area, sourceId: item.sourceId, name: item.name, outcome } : { area, sourceId: item.sourceId, name: item.name, outcome, message });
  }

  private applyArea(env: AreaEnv, area: MigrateArea, index: number, run: ApplyRun): MigrationAreaResult {
    const ab = env.bundle.areas[area]!;
    const result: MigrationAreaResult = { area, created: 0, updated: 0, skipped: 0, staged: 0, failed: 0 };
    const handler = syncHandler(area);
    const total = ab.items.length;
    const count = run.selected.length;
    const progress = (done: number) => run.hooks.onProgress?.({ area, done, total, areaIndex: index + 1, areaCount: count });
    const log = run.log;
    log('info', area, `${AREA_LABELS[area]}: ${total} item(s)`);
    progress(0);

    (ab.items as SourceItem<AreaPayloads[MigrateArea]>[]).forEach((item, i) => {
      if (i > 0 && i % PROGRESS_EVERY === 0) progress(i);
      if (ab.mode === 'report') {
        result.skipped++;
        return;
      }
      if (item.stageArea) {
        this.stage(env, item);
        result.staged++;
        this.note(run, area, item, 'staged', item.unsupported);
        if (item.unsupported) log('info', area, `${item.name}: ${item.unsupported}`);
        return;
      }
      if (item.unsupported) {
        result.skipped++;
        this.note(run, area, item, 'skipped', item.unsupported);
        log('warn', area, `${item.name}: skipped, ${item.unsupported}`);
        return;
      }
      const prior = importedTarget(env.db, env.instance, area, item.sourceId);
      if (prior) {
        if (prior.targetId !== null) env.idMap.set(`${area}:${item.sourceId}`, prior.targetId);
        result.skipped++;
        return;
      }
      if (!handler) {
        result.skipped++;
        return;
      }
      try {
        const outcome = env.db.transaction(() => {
          const existing = handler.find(env, item);
          if (existing) {
            if (env.policy === 'overwrite' && handler.overwrite) {
              const id = handler.overwrite(env, item, existing);
              this.recordImported(env, area, item.sourceId, id);
              return { kind: 'updated' as const, id };
            }
            if (env.policy === 'merge' && handler.merge) {
              const id = handler.merge(env, item, existing);
              this.recordImported(env, area, item.sourceId, id);
              return { kind: 'merged' as const, id };
            }
            // Remember which Arclight row stands for this upstream item, so other sources that
            // reference it (Seerr → a Radarr tag that Sonarr already created) resolve it.
            if (existing.id !== null) this.recordImported(env, area, item.sourceId, existing.id);
            return { kind: 'skipped' as const, id: existing.id, reason: existing.reason };
          }
          const id = handler.create(env, item);
          this.recordImported(env, area, item.sourceId, id);
          return { kind: 'created' as const, id };
        });
        if (outcome.id !== null) env.idMap.set(`${area}:${item.sourceId}`, outcome.id);
        if (outcome.kind === 'skipped') {
          result.skipped++;
          this.note(run, area, item, 'skipped', `kept existing (${outcome.reason})`);
          log('info', area, `${item.name}: kept existing (${outcome.reason})`);
        } else {
          if (outcome.kind === 'merged') result.updated++;
          else result[outcome.kind]++;
          this.note(run, area, item, outcome.kind);
        }
      } catch (err) {
        if (err instanceof SkipItem) {
          result.skipped++;
          this.note(run, area, item, 'skipped', err.message);
          log('info', area, `${item.name}: skipped, ${err.message}`);
        } else {
          result.failed++;
          const message = err instanceof Error ? err.message : String(err);
          this.note(run, area, item, 'failed', message);
          env.warn(area, `${item.name}: ${message}`, item.sourceId);
        }
      }
    });
    progress(total);
    log('info', area, `${AREA_LABELS[area]}: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.staged} staged, ${result.failed} failed`);
    return result;
  }

  private async applyAsyncArea(env: AreaEnv, area: MigrateArea, index: number, run: ApplyRun): Promise<MigrationAreaResult> {
    const ab = env.bundle.areas[area]!;
    const result: MigrationAreaResult = { area, created: 0, updated: 0, skipped: 0, staged: 0, failed: 0 };
    const handler = asyncHandler(area)!;
    const total = ab.items.length;
    const progress = (done: number) => run.hooks.onProgress?.({ area, done, total, areaIndex: index + 1, areaCount: run.selected.length });
    const log = run.log;
    log('info', area, `${AREA_LABELS[area]}: ${total} item(s)${env.dryRun ? ' (checked only, nothing changed)' : ''}`);
    progress(0);
    let i = 0;
    for (const item of ab.items as SourceItem<AreaPayloads[MigrateArea]>[]) {
      progress(i++);
      if (ab.mode === 'report') {
        result.skipped++;
        continue;
      }
      if (item.unsupported) {
        result.skipped++;
        this.note(run, area, item, 'skipped', item.unsupported);
        log('warn', area, `${item.name}: skipped, ${item.unsupported}`);
        continue;
      }
      const prior = importedTarget(env.db, env.instance, area, item.sourceId);
      if (prior) {
        if (prior.targetId !== null) env.idMap.set(`${area}:${item.sourceId}`, prior.targetId);
        result.skipped++;
        continue;
      }
      try {
        const existing = handler.find(env, item);
        const outcome = await handler.apply(env, item, existing);
        if (outcome.kind === 'skipped') {
          result.skipped++;
          this.note(run, area, item, 'skipped', outcome.message);
          if (outcome.message) log('info', area, `${item.name}: ${outcome.message}`);
        } else {
          if (!env.dryRun) this.recordImported(env, area, item.sourceId, outcome.id);
          if (outcome.id !== null) env.idMap.set(`${area}:${item.sourceId}`, outcome.id);
          if (outcome.kind === 'created') result.created++;
          else result.updated++;
          this.note(run, area, item, outcome.kind, outcome.message);
          if (outcome.message) log('info', area, `${item.name}: ${outcome.message}`);
        }
      } catch (err) {
        if (err instanceof SkipItem) {
          result.skipped++;
          this.note(run, area, item, 'skipped', err.message);
          log('info', area, `${item.name}: skipped, ${err.message}`);
        } else {
          result.failed++;
          const message = err instanceof Error ? err.message : String(err);
          this.note(run, area, item, 'failed', message);
          env.warn(area, `${item.name}: ${message}`, item.sourceId);
        }
      }
      // Engine adds and source calls are I/O: keep status requests flowing.
      await new Promise<void>((r) => setImmediate(r));
    }
    progress(total);
    log('info', area, `${AREA_LABELS[area]}: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed`);
    return result;
  }

  private recordImported(env: AreaEnv, area: MigrateArea, sourceId: string, targetId: number | null): void {
    env.db
      .insert(migrateImported)
      .values({ instance: env.instance, sourceApp: env.app, area, sourceId, targetId, importedAt: env.now })
      .onConflictDoUpdate({ target: [migrateImported.instance, migrateImported.area, migrateImported.sourceId], set: { targetId, importedAt: env.now } })
      .run();
  }

  private stagedRow(db: Db, area: string, app: string, sourceId: string) {
    return db
      .select({ id: migrateStaging.id, consumedAt: migrateStaging.consumedAt })
      .from(migrateStaging)
      .where(and(eq(migrateStaging.area, area as typeof migrateStaging.$inferSelect.area), eq(migrateStaging.sourceApp, app as typeof migrateStaging.$inferSelect.sourceApp), eq(migrateStaging.sourceId, sourceId)))
      .get();
  }

  /** Upsert one staged payload; rows a module already consumed are left alone. */
  private stage(env: AreaEnv, item: SourceItem<unknown>): void {
    const area = item.stageArea!;
    const payload = (item.payload as { staged?: unknown } | null)?.staged ?? item.payload;
    const existing = env.db
      .select({ id: migrateStaging.id, consumedAt: migrateStaging.consumedAt })
      .from(migrateStaging)
      .where(and(eq(migrateStaging.area, area), eq(migrateStaging.sourceApp, env.app), eq(migrateStaging.sourceId, item.sourceId)))
      .get();
    if (!existing) {
      env.db.insert(migrateStaging).values({ area, sourceApp: env.app, sourceId: item.sourceId, payload, stagedAt: env.now }).run();
    } else if (existing.consumedAt === null) {
      env.db.update(migrateStaging).set({ payload, stagedAt: env.now }).where(eq(migrateStaging.id, existing.id)).run();
    }
  }

  // ---- background job (single source) -----------------------------------------------------

  status(): MigrateStatus {
    return { ...this.state, log: [...this.state.log] };
  }

  /** Queue an import and start the MigrateFromArr job (or run inline when no scheduler). */
  start(input: { source: MigrateSourceInput } & MigrateApplyOptionsInput): MigrateStatus {
    const scheduler = this.scheduler;
    if (this.state.state === 'running') throw new MigrateError('BUSY', 'an import is already running');
    const source = MigrateSource.parse(input.source);
    const options = MigrateApplyOptions.parse(input);
    this.pending = { ...source, options };
    this.state = { ...idleStatus(), state: 'running', app: source.app, startedAt: this.now().toISOString() };
    if (scheduler?.has(MIGRATE_JOB)) void scheduler.run(MIGRATE_JOB, 'manual').catch((err: unknown) => this.fail(err));
    else void this.runPending().catch((err: unknown) => this.fail(err));
    return this.status();
  }

  registerJob(scheduler: Scheduler): void {
    this.scheduler = scheduler;
    scheduler.register({ name: MIGRATE_JOB, handler: async () => this.runPending() });
  }

  get schedulerRef(): Scheduler | undefined {
    return this.scheduler;
  }

  private fail(err: unknown): void {
    this.state = { ...this.state, state: 'failed', endedAt: this.now().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }

  currentJob(name: string = MIGRATE_JOB): Job | null {
    const row = this.db.select().from(jobs).where(and(eq(jobs.name, name), eq(jobs.status, 'running'))).orderBy(desc(jobs.id)).get();
    return row ? { ...row, durationMs: null } : null;
  }

  publishJob(job: Job | null, message: string): void {
    if (!job || !this.bus) return;
    this.bus.publish({ type: 'job', job: { ...job, message } });
  }

  /** The job body: run the queued request, keep `status` current, publish progress as job events. */
  async runPending(): Promise<string> {
    const req = this.pending;
    if (!req) return 'nothing queued';
    this.pending = null;
    if (this.state.state !== 'running') this.state = { ...idleStatus(), state: 'running', app: req.app, startedAt: this.now().toISOString() };
    const job = this.currentJob();
    this.state.jobId = job?.id ?? null;
    try {
      const { options, ...source } = req;
      const result = await this.apply(source, options, {
        onProgress: (p) => {
          this.state.progress = p;
          this.publishJob(job, `${AREA_LABELS[p.area]} ${p.done}/${p.total} (area ${p.areaIndex} of ${p.areaCount})`);
        },
        onLog: (entry) => {
          this.state.log.push(entry);
          if (this.state.log.length > LOG_LIMIT) this.state.log.splice(0, this.state.log.length - LOG_LIMIT);
        },
      });
      this.state = { ...this.state, state: 'completed', endedAt: this.now().toISOString(), result, progress: null };
      const created = result.areas.reduce((n, a) => n + a.created, 0);
      const failed = result.areas.reduce((n, a) => n + a.failed, 0);
      return `${result.dryRun ? 'dry run: ' : ''}${created} created, ${failed} failed`;
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }
}
