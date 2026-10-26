import { join } from 'node:path';
import type { AppContext, AppModule } from '../../app.js';
import { feedsRegistry } from '../../feeds.js';
import { notificationsServiceFor } from '../notifications/index.js';
import {
  getDefinitionFeedSettings,
  getIndexerGlobalSettings,
  getSection,
  updateDefinitionFeedSettings,
  updateIndexerGlobalSettings,
} from '../settings/service.js';
import { DefinitionFeed, type DefinitionFeedOptions } from './definition-feed.js';
import { DefinitionStore } from './definitions.js';
import { registerDefinitionFeedJob, registerIndexerJobs, rescheduleDefinitionFeed, rescheduleRssSync } from './jobs.js';
import { indexersRoutes } from './routes.js';
import { IndexersService } from './service.js';

export {
  IndexersService,
  IndexersError,
  BACKOFF_STEPS_MS,
  CAPS_TTL_MS,
  backoffFor,
  type IndexerStatusChange,
  type IndexerStatusListener,
  type ManualSearchResolver,
  type ReleaseDownload,
  type ReleasesHandler,
  type SearchGrabber,
  type SearchGrabOutcome,
  type SearchMode,
  type SearchOptions,
} from './service.js';
export { DefinitionStore } from './definitions.js';
export { DefinitionFeed, DefinitionFeedError, definitionSha256 } from './definition-feed.js';
export {
  RSS_SYNC_JOB,
  INDEXER_STATUS_CHECK_JOB,
  INDEXER_STATS_CLEANUP_JOB,
  rssCronFor,
  rescheduleRssSync,
  DEFINITION_FEED_SYNC_JOB,
  definitionFeedCronFor,
} from './jobs.js';
export * from './schema.js';

// One service per app context, so the release pipeline (another module) and the routes
// share failure state, rate limiters, definition clients and hooks in-process.
const services = new WeakMap<AppContext, IndexersService>();

export function indexersServiceFor(ctx: AppContext): IndexersService {
  let service = services.get(ctx);
  if (!service) {
    const log = ctx.log.child({ module: 'indexers' });
    const configDir = ctx.config?.configDir;
    const definitions = new DefinitionStore({
      log,
      watch: true,
      ...(configDir ? { customDir: join(configDir, 'definitions'), feedDir: join(configDir, 'definitions', 'feed') } : {}),
    });
    service = new IndexersService({ db: ctx.db, log, definitions });
    services.set(ctx, service);
  }
  return service;
}

const feeds = new WeakMap<AppContext, DefinitionFeed>();

/** The definition feed of a context; undefined without a config directory. */
export function definitionFeedFor(ctx: AppContext, overrides: Partial<DefinitionFeedOptions> = {}): DefinitionFeed | undefined {
  let feed = feeds.get(ctx);
  if (!feed) {
    const store = indexersServiceFor(ctx).definitions;
    const feedDir = store.feedDir;
    if (!feedDir) return undefined;
    feed = new DefinitionFeed({
      store,
      feedDir,
      settings: () => getDefinitionFeedSettings(ctx.db),
      log: ctx.log.child({ module: 'indexers', feature: 'definition-feed' }),
      notify: (event) => notificationsServiceFor(ctx).dispatch(event),
      ...overrides,
    });
    feeds.set(ctx, feed);
  }
  return feed;
}

export const indexersModule: AppModule = (ctx) => async (app) => {
  const service = indexersServiceFor(ctx);
  const feed = definitionFeedFor(ctx);
  await service.definitions.ready();
  await service.definitions.startWatching();
  app.addHook('onClose', async () => service.definitions.stopWatching());

  await app.register(
    indexersRoutes(service, {
      settings: {
        get: () => getIndexerGlobalSettings(ctx.db),
        update: (value) => {
          const saved = updateIndexerGlobalSettings(ctx.db, value);
          rescheduleRssSync(ctx.scheduler, saved.rssSyncIntervalMinutes);
          return saved;
        },
      },
      ...(feed
        ? {
            feed: {
              feed,
              getSettings: () => getDefinitionFeedSettings(ctx.db),
              updateSettings: (value) => {
                const saved = updateDefinitionFeedSettings(ctx.db, value);
                rescheduleDefinitionFeed(ctx.scheduler, saved);
                return saved;
              },
            },
          }
        : {}),
    }),
  );
  if (feed) {
    registerDefinitionFeedJob(ctx.scheduler, feed, () => getDefinitionFeedSettings(ctx.db));
    const unregister = feedsRegistry(ctx).register({ id: 'definitions', name: 'Indexer definitions', status: () => feed.feedStatus() });
    app.addHook('onClose', async () => unregister());
  }
  registerIndexerJobs(ctx.scheduler, service, { rssIntervalMinutes: getSection(ctx.db, 'indexers').rssSyncIntervalMinutes });
};
