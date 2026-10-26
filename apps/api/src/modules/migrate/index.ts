import type { AppContext, AppModule } from '../../app.js';
import { backupServiceFor } from '../backup/index.js';
import { indexersServiceFor } from '../indexers/index.js';
import { torrentServiceFor } from '../torrent/index.js';
import type { DefinitionRef, MigrateDeps } from './deps.js';
import { migrateRoutes } from './routes.js';
import { MigrateService } from './service.js';
import { MigrateStackRunner } from './stack.js';

export { MigrateService, MIGRATE_JOB, AREA_ORDER, AREA_LABELS, sourceInstance, maskSource, type MigrateServiceOptions } from './service.js';
export { MigrateStackRunner, MIGRATE_STACK_JOB, STACK_ORDER } from './stack.js';
export { MigrateError } from './errors.js';
export { detectSources } from './sources.js';
export type { MigrateDeps, DefinitionRef } from './deps.js';
export * from './schema.js';

// One service per app context: the in-memory run status must be shared between the job and
// the /migrate/status route.
const services = new WeakMap<AppContext, { service: MigrateService; stack: MigrateStackRunner }>();

/** Arclight's indexer definitions (built-in, feed, custom, community) by id. */
function definitionLookup(ctx: AppContext): (id: string) => DefinitionRef | null {
  return (id) => {
    const store = indexersServiceFor(ctx).definitions;
    const wanted = id.trim().toLowerCase();
    const summary = store.list().find((d) => d.id.toLowerCase() === wanted);
    if (!summary) return null;
    return {
      id: summary.id,
      name: summary.name,
      privacy: summary.privacy,
      settings: summary.settingsFields.map((s) => s.name),
      links: summary.links,
    };
  };
}

/** The real wiring: backups, the built-in engine and the indexer catalogue, resolved lazily. */
export function migrateDepsFor(ctx: AppContext): MigrateDeps {
  return {
    ctx,
    createBackup: async () => {
      const b = await backupServiceFor(ctx).create('manual');
      return { id: b.id, name: b.name };
    },
    torrentSession: () => torrentServiceFor(ctx).session,
    findDefinition: definitionLookup(ctx),
  };
}

function bundleFor(ctx: AppContext): { service: MigrateService; stack: MigrateStackRunner } {
  let entry = services.get(ctx);
  if (!entry) {
    const service = new MigrateService({ db: ctx.db, log: ctx.log.child({ module: 'migrate' }), bus: ctx.bus, deps: migrateDepsFor(ctx) });
    entry = { service, stack: new MigrateStackRunner(service) };
    services.set(ctx, entry);
  }
  return entry;
}

export function migrateServiceFor(ctx: AppContext): MigrateService {
  return bundleFor(ctx).service;
}

export function migrateStackFor(ctx: AppContext): MigrateStackRunner {
  return bundleFor(ctx).stack;
}

export const migrateModule: AppModule = (ctx) => async (app) => {
  const { service, stack } = bundleFor(ctx);
  service.registerJob(ctx.scheduler);
  stack.registerScheduler(ctx.scheduler);
  stack.recoverInterrupted();
  await app.register(migrateRoutes(service, stack));
};
