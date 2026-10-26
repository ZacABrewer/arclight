import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { TransactionRollbackError } from 'drizzle-orm';
import pino, { type Logger } from 'pino';
import {
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
import { createServices, HANDLERS, importedTarget, SkipItem, type AreaEnv, type AreaHandler } from './areas.js';
import { readBazarr } from './bazarr-reader.js';
import { MigrateError } from './errors.js';
import { readProwlarr } from './prowlarr-reader.js';
import { readRadarr } from './radarr-reader.js';
import { migrateImported, migrateStaging } from './schema.js';
import { readSeerr } from './seerr-reader.js';
import { readSonarr } from './sonarr-reader.js';
import { detectSources, type DetectOptions } from './sources.js';
import type { AreaPayloads, SourceBundle, SourceItem } from './types.js';

// Plans and applies an adoption import. `plan` reads the source and compares it with the
// current database without writing. `apply` re-reads the source and writes area by area,
// each area in its own transaction (each item in a savepoint, so one bad row does not undo
// its area); a dry run wraps everything in one transaction that is rolled back. Imported
// upstream ids are remembered in `migrate_imported`, so re-running skips them; existing
// Arclight rows are never deleted, only skipped or (policy `overwrite`) updated.

export const MIGRATE_JOB = 'MigrateFromArr';

/** Dependency-safe order: things referenced before the things that reference them. */
export const AREA_ORDER: readonly MigrateArea[] = [
  'tags',
  'rootFolders',
  'customFormats',
  'qualityProfiles',
  'delayProfiles',
  'downloadClients',
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
  'indexerProxies',
  'applications',
  'subtitleProfiles',
  'subtitleProviders',
  'subtitleHistory',
  'users',
  'requests',
  'issues',
  'requestSettings',
];

export const AREA_LABELS: Record<MigrateArea, string> = {
  tags: 'Tags',
  rootFolders: 'Root folders',
  customFormats: 'Custom formats',
  qualityProfiles: 'Quality profiles',
  delayProfiles: 'Delay profiles',
  releaseProfiles: 'Release profiles',
  indexers: 'Indexers',
  indexerProxies: 'Indexer proxies and definitions',
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
  subtitleProviders: 'Subtitle providers',
  subtitleHistory: 'Subtitle history and blacklist',
  users: 'Users',
  requests: 'Requests',
  issues: 'Issues',
  requestSettings: 'Request settings',
};

const LOG_LIMIT = 1000;
const PROGRESS_EVERY = 25;

export interface MigrateServiceOptions {
  db: Db;
  log?: Logger;
  bus?: EventBus;
  now?: () => Date;
  detect?: DetectOptions;
}

export interface ApplyHooks {
  onProgress?: (progress: MigrateProgress) => void;
  onLog?: (entry: MigrationLogEntry) => void;
}

type ApplyRequest = MigrateSource & { options: MigrateApplyOptions };

/** Stable id of a source installation: app + database path. */
export function sourceInstance(source: Pick<MigrateSource, 'app' | 'dbPath'>): string {
  return createHash('sha1').update(`${source.app}|${resolve(source.dbPath).toLowerCase()}`).digest('hex').slice(0, 16);
}

function isPlan(v: unknown): v is MigrationPlan {
  return !!v && typeof v === 'object' && 'source' in v && 'areas' in v;
}

function idleStatus(): MigrateStatus {
  return { state: 'idle', app: null, jobId: null, startedAt: null, endedAt: null, progress: null, log: [], result: null, error: null };
}

export class MigrateService {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly bus: EventBus | undefined;
  private readonly now: () => Date;
  private readonly detectOptions: DetectOptions;
  private state: MigrateStatus = idleStatus();
  private pending: ApplyRequest | null = null;
  private scheduler: Scheduler | undefined;

  constructor(opts: MigrateServiceOptions) {
    this.db = opts.db;
    this.log = opts.log ?? pino({ level: 'silent' });
    this.bus = opts.bus;
    this.now = opts.now ?? (() => new Date());
    this.detectOptions = opts.detect ?? {};
  }

  // ---- sources ---------------------------------------------------------------------------

  sources(): MigrateSourceCandidate[] {
    return detectSources(this.detectOptions);
  }

  readBundle(source: MigrateSource): SourceBundle {
    switch (source.app) {
      case 'sonarr':
        return readSonarr(source.dbPath, source.pathMappings);
      case 'radarr':
        return readRadarr(source.dbPath, source.pathMappings);
      case 'prowlarr':
        return readProwlarr(source.dbPath, source.configPath, source.pathMappings);
      case 'bazarr':
        return readBazarr(source.dbPath, source.configPath, source.pathMappings);
      case 'seerr':
        return readSeerr(source.dbPath, source.configPath, source.pathMappings);
    }
  }

  // ---- plan ------------------------------------------------------------------------------

  plan(input: MigrateSourceInput): MigrationPlan {
    const source = MigrateSource.parse(input);
    const bundle = this.readBundle(source);
    const instance = sourceInstance(source);
    const env = this.env(this.db, bundle, instance, 'skip', new Map(), () => undefined);
    const areas: MigrationAreaPlan[] = [];
    const conflicts: MigrationConflict[] = [];
    const unsupported: MigrationUnsupported[] = [];

    for (const area of AREA_ORDER) {
      const ab = bundle.areas[area];
      if (!ab) continue;
      const row: MigrationAreaPlan = { area, label: AREA_LABELS[area], mode: ab.mode, total: ab.items.length, create: 0, conflicts: 0, alreadyImported: 0, unsupported: 0, details: { ...(ab.details ?? {}) } };
      const handler = HANDLERS[area] as AreaHandler<MigrateArea> | undefined;
      for (const item of ab.items as SourceItem<AreaPayloads[MigrateArea]>[]) {
        if (ab.mode === 'report') continue;
        if (item.unsupported) {
          row.unsupported++;
          unsupported.push({ area, sourceId: item.sourceId, name: item.name, reason: item.stageArea ? `${item.unsupported}` : item.unsupported });
          continue;
        }
        if (item.stageArea) {
          if (this.stagedRow(item.stageArea, bundle.app, item.sourceId)) row.alreadyImported++;
          else row.create++;
          continue;
        }
        if (importedTarget(this.db, instance, area, item.sourceId)) {
          row.alreadyImported++;
          continue;
        }
        const existing = handler?.find(env, item) ?? null;
        if (existing) {
          row.conflicts++;
          conflicts.push({ area, sourceId: item.sourceId, name: item.name, existingId: existing.id, reason: existing.reason });
        } else row.create++;
      }
      areas.push(row);
    }
    return {
      source,
      app: source.app,
      schemaVersion: bundle.schemaVersion,
      areas,
      warnings: bundle.warnings,
      conflicts,
      unsupported,
      createdAt: this.now().toISOString(),
    };
  }

  // ---- apply -----------------------------------------------------------------------------

  async apply(planOrSource: MigrationPlan | MigrateSourceInput, optionsInput: MigrateApplyOptionsInput = {}, hooks: ApplyHooks = {}): Promise<MigrationResult> {
    const source = MigrateSource.parse(isPlan(planOrSource) ? planOrSource.source : planOrSource);
    const options = MigrateApplyOptions.parse(optionsInput);
    const startedAt = this.now().toISOString();
    const bundle = this.readBundle(source);
    const instance = sourceInstance(source);
    const selected = AREA_ORDER.filter((a) => bundle.areas[a] && (options.areas.length === 0 || options.areas.includes(a)));
    const warnings: MigrationWarning[] = [...bundle.warnings.filter((w) => selected.includes(w.area))];
    const idMap = new Map<string, number>();
    const results: MigrationAreaResult[] = [];

    const log = (level: MigrationLogEntry['level'], area: MigrateArea | null, message: string) => {
      const entry: MigrationLogEntry = { time: this.now().toISOString(), level, area, message };
      hooks.onLog?.(entry);
      this.log[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info']({ area }, message);
    };
    const warn = (area: MigrateArea, message: string, sourceId?: string) => {
      warnings.push(sourceId === undefined ? { area, message } : { area, message, sourceId });
      log('warn', area, message);
    };

    log('info', null, `${options.dryRun ? 'Dry run: ' : ''}importing ${selected.length} area(s) from ${source.app} (${source.dbPath}), conflicts: ${options.conflictPolicy}`);
    const runArea = (db: Db, area: MigrateArea, index: number): MigrationAreaResult => {
      const env = this.env(db, bundle, instance, options.conflictPolicy, idMap, warn);
      return this.applyArea(env, area, index, selected.length, hooks, log);
    };

    if (options.dryRun) {
      try {
        this.db.transaction((tx) => {
          const txDb = tx as unknown as Db;
          selected.forEach((area, i) => {
            try {
              results.push(txDb.transaction((areaTx) => runArea(areaTx as unknown as Db, area, i)));
            } catch (err) {
              results.push(this.failedArea(area, bundle, err, log));
            }
          });
          tx.rollback();
        });
      } catch (err) {
        if (!(err instanceof TransactionRollbackError)) throw err;
      }
    } else {
      for (const [i, area] of selected.entries()) {
        try {
          // A drizzle transaction object exposes the same query API as the database handle;
          // services take a `Db`, so the transaction is handed to them under that type.
          results.push(this.db.transaction((tx) => runArea(tx as unknown as Db, area, i)));
        } catch (err) {
          results.push(this.failedArea(area, bundle, err, log));
        }
        // Let status requests and bus deliveries through between areas.
        await new Promise<void>((r) => setImmediate(r));
      }
    }

    const totals = results.reduce((acc, r) => ({ created: acc.created + r.created, updated: acc.updated + r.updated, staged: acc.staged + r.staged, failed: acc.failed + r.failed }), { created: 0, updated: 0, staged: 0, failed: 0 });
    log('info', null, `${options.dryRun ? 'Dry run finished (nothing saved)' : 'Import finished'}: ${totals.created} created, ${totals.updated} updated, ${totals.staged} staged, ${totals.failed} failed`);
    return { app: source.app, dryRun: options.dryRun, areas: results, warnings, startedAt, endedAt: this.now().toISOString() };
  }

  private failedArea(area: MigrateArea, bundle: SourceBundle, err: unknown, log: (l: MigrationLogEntry['level'], a: MigrateArea | null, m: string) => void): MigrationAreaResult {
    log('error', area, `area failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
    return { area, created: 0, updated: 0, skipped: 0, staged: 0, failed: bundle.areas[area]?.items.length ?? 0 };
  }

  private env(
    db: Db,
    bundle: SourceBundle,
    instance: string,
    policy: MigrateApplyOptions['conflictPolicy'],
    idMap: Map<string, number>,
    warn: AreaEnv['warn'],
  ): AreaEnv {
    return { db, app: bundle.app, instance, bundle, policy, now: this.now().toISOString(), log: this.log, idMap, warn, services: createServices(db, this.log) };
  }

  private applyArea(
    env: AreaEnv,
    area: MigrateArea,
    index: number,
    count: number,
    hooks: ApplyHooks,
    log: (level: MigrationLogEntry['level'], area: MigrateArea | null, message: string) => void,
  ): MigrationAreaResult {
    const ab = env.bundle.areas[area]!;
    const result: MigrationAreaResult = { area, created: 0, updated: 0, skipped: 0, staged: 0, failed: 0 };
    const handler = HANDLERS[area] as AreaHandler<MigrateArea> | undefined;
    const total = ab.items.length;
    const progress = (done: number) => hooks.onProgress?.({ area, done, total, areaIndex: index + 1, areaCount: count });
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
        if (item.unsupported) log('info', area, `${item.name}: ${item.unsupported}`);
        return;
      }
      if (item.unsupported) {
        result.skipped++;
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
            return { kind: 'skipped' as const, id: existing.id, reason: existing.reason };
          }
          const id = handler.create(env, item);
          this.recordImported(env, area, item.sourceId, id);
          return { kind: 'created' as const, id };
        });
        if (outcome.id !== null) env.idMap.set(`${area}:${item.sourceId}`, outcome.id);
        if (outcome.kind === 'skipped') {
          result.skipped++;
          log('info', area, `${item.name}: kept existing (${outcome.reason})`);
        } else result[outcome.kind]++;
      } catch (err) {
        if (err instanceof SkipItem) {
          result.skipped++;
          log('info', area, `${item.name}: skipped, ${err.message}`);
        } else {
          result.failed++;
          env.warn(area, `${item.name}: ${err instanceof Error ? err.message : String(err)}`, item.sourceId);
        }
      }
    });
    progress(total);
    log('info', area, `${AREA_LABELS[area]}: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.staged} staged, ${result.failed} failed`);
    return result;
  }

  private recordImported(env: AreaEnv, area: MigrateArea, sourceId: string, targetId: number | null): void {
    env.db
      .insert(migrateImported)
      .values({ instance: env.instance, sourceApp: env.app, area, sourceId, targetId, importedAt: env.now })
      .onConflictDoUpdate({ target: [migrateImported.instance, migrateImported.area, migrateImported.sourceId], set: { targetId, importedAt: env.now } })
      .run();
  }

  private stagedRow(area: string, app: string, sourceId: string) {
    return this.db
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

  // ---- background job --------------------------------------------------------------------

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

  private fail(err: unknown): void {
    this.state = { ...this.state, state: 'failed', endedAt: this.now().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }

  private currentJob(): Job | null {
    const row = this.db.select().from(jobs).where(and(eq(jobs.name, MIGRATE_JOB), eq(jobs.status, 'running'))).orderBy(desc(jobs.id)).get();
    return row ? { ...row, durationMs: null } : null;
  }

  /** The job body: run the queued request, keep `status` current, publish progress as job events. */
  async runPending(): Promise<string> {
    const req = this.pending;
    if (!req) return 'nothing queued';
    this.pending = null;
    if (this.state.state !== 'running') this.state = { ...idleStatus(), state: 'running', app: req.app, startedAt: this.now().toISOString() };
    const job = this.currentJob();
    this.state.jobId = job?.id ?? null;
    const publish = (message: string) => {
      if (!job || !this.bus) return;
      this.bus.publish({ type: 'job', job: { ...job, message } });
    };
    try {
      const { options, ...source } = req;
      const result = await this.apply(source, options, {
        onProgress: (p) => {
          this.state.progress = p;
          publish(`${AREA_LABELS[p.area]} ${p.done}/${p.total} (area ${p.areaIndex} of ${p.areaCount})`);
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
