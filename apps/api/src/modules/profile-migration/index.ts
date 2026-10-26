import type { AppContext, AppModule } from '../../app.js';
import { releasesServiceFor } from '../releases/index.js';
import { getSection } from '../settings/service.js';
import { profileMigrationRoutes } from './routes.js';
import {
  cronForInterval,
  PROFILE_FIT_REFRESH_JOB,
  PROFILE_MIGRATION_JOB,
  ProfileMigrationService,
} from './service.js';

export * from './schema.js';
export {
  cronForInterval,
  freeSpaceAt,
  PROFILE_FIT_REFRESH_JOB,
  PROFILE_MIGRATION_JOB,
  PROFILE_MIGRATION_SEARCH_JOB,
  ProfileMigrationError,
  ProfileMigrationService,
  type EvaluateScope,
  type MigrationSearchTarget,
  type ProfileMigrationPorts,
  type ReevaluateSummary,
} from './service.js';

// One service per app context: the decision engine and imports ask it for each profile's rule
// (through wiring.ts), the routes and jobs below drive it.
const services = new WeakMap<AppContext, ProfileMigrationService>();

export function profileMigrationServiceFor(ctx: AppContext): ProfileMigrationService {
  let service = services.get(ctx);
  if (!service) {
    service = new ProfileMigrationService({
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'profile-migration' }),
      scheduler: ctx.scheduler,
      ports: {
        // Through the normal decision engine, so "why this release" and every spec apply.
        search: (target, opts) => releasesServiceFor(ctx).searchFor(target, opts),
      },
    });
    services.set(ctx, service);
  }
  return service;
}

export const profileMigrationModule: AppModule = (ctx) => async (app) => {
  const service = profileMigrationServiceFor(ctx);

  // Re-judge files whenever what they are judged by changes.
  const unsubscribe = ctx.bus.subscribe((event) => {
    if (event.type === 'library') {
      if (event.action === 'refreshed') return;
      service.requestReevaluate(event.mediaType === 'series' ? { seriesIds: [event.id] } : { movieIds: [event.id] });
    } else if (event.type === 'profile') {
      service.requestReevaluate('all');
    }
  });
  app.addHook('onClose', async () => {
    unsubscribe();
    service.dispose();
  });
  // First pass after start (and after an upgrade that added this module): judge the whole library.
  app.addHook('onReady', async () => {
    service.requestReevaluate('all');
  });

  ctx.scheduler.register({
    name: PROFILE_MIGRATION_JOB,
    cron: cronForInterval(getSection(ctx.db, 'profileMigration').intervalMinutes),
    handler: async ({ signal }) => service.runAutomatic(signal),
  });
  ctx.scheduler.register({ name: PROFILE_FIT_REFRESH_JOB, cron: '10 4 * * *', handler: async () => service.housekeeping() });

  await app.register(profileMigrationRoutes(service));
};
