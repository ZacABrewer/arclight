import type { AppContext, AppModule } from '../../app.js';
import { feedsRegistry } from '../../feeds.js';
import { notificationsServiceFor } from '../notifications/index.js';
import { registerGuidesJobs, rescheduleGuidesSync } from './jobs.js';
import { guidesRoutes } from './routes.js';
import { GuidesService, type GuidesServiceOptions } from './service.js';

export { GuidesService, GuidesError, type GuidesServiceOptions } from './service.js';
export { GUIDES_SYNC_JOB, guidesCronFor, rescheduleGuidesSync } from './jobs.js';
export { buildDiff, matchesPattern, selectFormats, resolveMappings } from './diff.js';
export { parseGuideFormat, parseGuideProfile } from './parse.js';
export { GuideRepository, fetchGuide, type FetchLike } from './source.js';
export * from './schema.js';

// TRaSH-style guide sync: custom formats and quality-profile scores follow a guide repository.

const services = new WeakMap<AppContext, GuidesService>();

export function guidesServiceFor(ctx: AppContext, overrides: Partial<GuidesServiceOptions> = {}): GuidesService {
  let service = services.get(ctx);
  if (!service) {
    service = new GuidesService({
      db: ctx.db,
      log: ctx.log.child({ module: 'guides' }),
      notify: (event) => notificationsServiceFor(ctx).dispatch(event),
      ...overrides,
    });
    services.set(ctx, service);
  }
  return service;
}

export const guidesModule: AppModule = (ctx) => async (app) => {
  const service = guidesServiceFor(ctx);
  await app.register(guidesRoutes(service, { onSettingsChanged: (s) => rescheduleGuidesSync(ctx.scheduler, s) }));
  registerGuidesJobs(ctx.scheduler, service);
  const unregister = feedsRegistry(ctx).register({ id: 'guides', name: 'Guides (custom formats & scores)', status: () => service.feedStatus() });
  app.addHook('onClose', async () => unregister());
};
