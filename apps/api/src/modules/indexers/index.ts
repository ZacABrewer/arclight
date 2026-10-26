import { join } from 'node:path';
import type { CommunityCatalogueSettings } from '@arclight/shared';
import type { AppContext, AppModule } from '../../app.js';
import { feedsRegistry } from '../../feeds.js';
import { notificationsServiceFor } from '../notifications/index.js';
import {
  getCommunityCatalogueSettings,
  getDefinitionFeedSettings,
  getIndexerGlobalSettings,
  getSection,
  updateCommunityCatalogueSettings,
  updateDefinitionFeedSettings,
  updateIndexerGlobalSettings,
} from '../settings/service.js';
import { CommunityCatalogue, type CommunityCatalogueOptions } from './community-catalogue.js';
import { DefinitionFeed, type DefinitionFeedOptions } from './definition-feed.js';
import { DefinitionStore } from './definitions.js';
import {
  COMMUNITY_CATALOGUE_SYNC_JOB,
  registerCommunityCatalogueJob,
  registerDefinitionFeedJob,
  registerIndexerJobs,
  rescheduleCommunityCatalogue,
  rescheduleDefinitionFeed,
  rescheduleRssSync,
} from './jobs.js';
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
export { CommunityCatalogue, CommunityCatalogueError, gitBlobSha1, parseListing } from './community-catalogue.js';
export { buildCatalogue, catalogueEntry } from './catalogue.js';
export {
  RSS_SYNC_JOB,
  INDEXER_STATUS_CHECK_JOB,
  INDEXER_STATS_CLEANUP_JOB,
  rssCronFor,
  rescheduleRssSync,
  DEFINITION_FEED_SYNC_JOB,
  definitionFeedCronFor,
  COMMUNITY_CATALOGUE_SYNC_JOB,
  communityCatalogueCronFor,
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
      communityEnabled: () => getCommunityCatalogueSettings(ctx.db).enabled,
      ...(configDir
        ? {
            customDir: join(configDir, 'definitions'),
            feedDir: join(configDir, 'definitions', 'feed'),
            communityDir: join(configDir, 'definitions', 'community'),
          }
        : {}),
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

const communities = new WeakMap<AppContext, CommunityCatalogue>();

/** The community catalogue of a context; undefined without a config directory. */
export function communityCatalogueFor(ctx: AppContext, overrides: Partial<CommunityCatalogueOptions> = {}): CommunityCatalogue | undefined {
  let catalogue = communities.get(ctx);
  if (!catalogue) {
    const store = indexersServiceFor(ctx).definitions;
    const dir = store.communityDir;
    if (!dir) return undefined;
    catalogue = new CommunityCatalogue({
      store,
      dir,
      settings: () => getCommunityCatalogueSettings(ctx.db),
      log: ctx.log.child({ module: 'indexers', feature: 'community-catalogue' }),
      ...overrides,
    });
    communities.set(ctx, catalogue);
  }
  return catalogue;
}

/** Delay before the first community sync after start, when one is due. */
export const COMMUNITY_STARTUP_DELAY_MS = 90_000;

export const indexersModule: AppModule = (ctx) => async (app) => {
  const service = indexersServiceFor(ctx);
  const feed = definitionFeedFor(ctx);
  const community = communityCatalogueFor(ctx);
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
      ...(community
        ? {
            catalogue: {
              community: async () => {
                const last = await community.lastSync();
                return { enabled: getCommunityCatalogueSettings(ctx.db).enabled, lastSuccessAt: last.lastSuccessAt, lastError: last.lastError };
              },
            },
            community: {
              catalogue: community,
              getSettings: () => getCommunityCatalogueSettings(ctx.db),
              updateSettings: async (value: CommunityCatalogueSettings) => {
                const before = getCommunityCatalogueSettings(ctx.db);
                const saved = updateCommunityCatalogueSettings(ctx.db, value);
                rescheduleCommunityCatalogue(ctx.scheduler, saved);
                // Turning it on or off changes what the store loads.
                if (before.enabled !== saved.enabled) await service.definitions.reload();
                return saved;
              },
            },
          }
        : {}),
    }),
  );
  if (community) {
    registerCommunityCatalogueJob(ctx.scheduler, community, () => getCommunityCatalogueSettings(ctx.db));
    const unregister = feedsRegistry(ctx).register({ id: 'communityDefinitions', name: 'Community indexer catalogue', status: () => community.feedStatus() });
    app.addHook('onClose', async () => unregister());
    // First sync after start when one is due (never synced, or overdue), so a fresh install
    // fills the catalogue without waiting for the cron. Test runs never fetch.
    if (!process.env['VITEST']) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      app.addHook('onReady', async () => {
        timer = setTimeout(() => {
          void community
            .due()
            .then((due) => (due ? ctx.scheduler.run(COMMUNITY_CATALOGUE_SYNC_JOB, 'system') : undefined))
            .catch((err: unknown) => ctx.log.warn({ err }, 'community catalogue startup sync failed'));
        }, COMMUNITY_STARTUP_DELAY_MS);
        timer.unref();
      });
      app.addHook('onClose', async () => clearTimeout(timer));
    }
  }
  if (feed) {
    registerDefinitionFeedJob(ctx.scheduler, feed, () => getDefinitionFeedSettings(ctx.db));
    const unregister = feedsRegistry(ctx).register({ id: 'definitions', name: 'Indexer definitions', status: () => feed.feedStatus() });
    app.addHook('onClose', async () => unregister());
  }
  registerIndexerJobs(ctx.scheduler, service, { rssIntervalMinutes: getSection(ctx.db, 'indexers').rssSyncIntervalMinutes });
};
