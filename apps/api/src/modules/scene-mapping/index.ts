import type { AppContext, AppModule } from '../../app.js';
import { feedsRegistry } from '../../feeds.js';
import { getImportsService } from '../imports/index.js';
import { SceneMappingFeed, type SceneMappingFeedOptions } from './feed.js';
import { registerSceneMappingJobs } from './jobs.js';
import { sceneMappingRoutes } from './routes.js';
import { SceneMappingService } from './service.js';

export * from './schema.js';
export { SceneMappingService, SceneMappingError, loadSceneRules } from './service.js';
export { SceneMappingFeed, SCENE_MAPPING_FEED_STATE_KEY } from './feed.js';
export { SCENE_MAPPING_SYNC_JOB } from './jobs.js';
export { resolveSceneNumbering, absoluteIndex, type SceneRule, type SceneResolution } from './mapping.js';

// Scene / absolute numbering: per-series rules (manual editor + community feed) the release
// matcher applies before episode lookup. Tables: scene_mappings. Job: SceneMappingSync (daily).

const services = new WeakMap<AppContext, SceneMappingService>();

export function sceneMappingServiceFor(ctx: AppContext): SceneMappingService {
  let service = services.get(ctx);
  if (!service) {
    service = new SceneMappingService({
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'scene-mapping' }),
      rescan: (seriesId) => getImportsService(ctx).rescanSeries(seriesId),
    });
    services.set(ctx, service);
  }
  return service;
}

/** `feed` overrides are a test seam (fake fetch, url). */
export const sceneMappingModuleWith =
  (feedOptions: Partial<SceneMappingFeedOptions> = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const service = sceneMappingServiceFor(ctx);
    const feed = new SceneMappingFeed({ db: ctx.db, log: ctx.log.child({ module: 'scene-mapping-feed' }), ...feedOptions });
    await app.register(sceneMappingRoutes(service, feed));
    registerSceneMappingJobs(ctx.scheduler, feed);
    const unregister = feedsRegistry(ctx).register({ id: 'sceneMappings', name: 'Scene numbering mappings', status: () => feed.feedStatus() });
    const unsubscribe = ctx.bus.subscribe((event) => {
      if (event.type === 'library' && event.action === 'deleted' && event.mediaType === 'series') service.deleteForSeries(event.id);
    });
    app.addHook('onClose', async () => {
      unregister();
      unsubscribe();
    });
  };

export const sceneMappingModule: AppModule = sceneMappingModuleWith();
