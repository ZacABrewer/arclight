import type { AppContext, AppModule } from '../../app.js';
import { mediaServersServiceFor } from '../media-servers/index.js';
import { notificationsServiceFor } from '../notifications/index.js';
import { getFeatureSettings } from '../settings/service.js';
import { podcastRoutes, podcastSettingsRoutes } from './routes.js';
import { PodcastsService, type PodcastsServiceOptions } from './service.js';
import { PodcastSuggestions } from './suggestions.js';
import { FfmpegTagger } from './tagger.js';

export * from './schema.js';
export { PodcastsService, PodcastsError, podcastCalendarItems, toPodcast, toEpisode } from './service.js';
export { PodcastSuggestions } from './suggestions.js';
export { parseFeed, FeedParseError } from './feed.js';
export { parseOpml, buildOpml } from './opml.js';

// Podcasts (docs/using/podcasts.md): their own section, tables and settings, gated by
// `features.podcasts`. Jobs: RefreshPodcasts polls due feeds every 15 minutes (each feed keeps
// its own next-poll time), DownloadPodcastEpisodes fetches queued episodes (also kicked after a
// subscribe, refresh or manual queue), PodcastRetention applies keep-last / delete-played and
// first reads played state from the media servers. All are no-ops while the feature is off.

export const REFRESH_PODCASTS_JOB = 'RefreshPodcasts';
export const DOWNLOAD_PODCASTS_JOB = 'DownloadPodcastEpisodes';
export const PODCAST_RETENTION_JOB = 'PodcastRetention';

export interface PodcastsRuntime {
  service(): PodcastsService;
  suggestions(): PodcastSuggestions;
  /** Queue a download run (coalesced while one is running). */
  kickDownloads(): void;
  /** Queue a poll of every monitored feed. */
  refreshAll(): void;
}

const runtimes = new WeakMap<AppContext, PodcastsRuntime>();

/** Test seams; production passes none. */
export type PodcastsModuleOptions = Partial<Pick<PodcastsServiceOptions, 'transport' | 'tagger' | 'notify' | 'refreshMediaServers' | 'playedPaths' | 'now'>>;

export function podcastsRuntimeFor(ctx: AppContext, opts: PodcastsModuleOptions = {}): PodcastsRuntime {
  let rt = runtimes.get(ctx);
  if (rt) return rt;
  let service: PodcastsService | null = null;
  let suggestions: PodcastSuggestions | null = null;
  let downloadRunning = false;
  let downloadAgain = false;
  const log = ctx.log.child({ module: 'podcasts' });

  const kickDownloads = (): void => {
    if (downloadRunning) {
      downloadAgain = true;
      return;
    }
    downloadRunning = true;
    void ctx.scheduler
      .run(DOWNLOAD_PODCASTS_JOB, 'manual')
      .catch((err: unknown) => log.warn({ err }, 'podcast download run failed'))
      .finally(() => {
        downloadRunning = false;
        if (downloadAgain) {
          downloadAgain = false;
          kickDownloads();
        }
      });
  };

  rt = {
    service() {
      service ??= new PodcastsService({
        db: ctx.db,
        bus: ctx.bus,
        log,
        tagger: opts.tagger ?? new FfmpegTagger(),
        ...(opts.transport ? { transport: opts.transport } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        notify: opts.notify ?? ((event) => notificationsServiceFor(ctx).dispatch(event)),
        refreshMediaServers:
          opts.refreshMediaServers ?? ((path, updateType) => mediaServersServiceFor(ctx).refreshPath({ path, mediaType: 'podcast', updateType })),
        playedPaths: opts.playedPaths ?? ((root) => mediaServersServiceFor(ctx).playedPodcastPaths(root)),
        onWanted: () => kickDownloads(),
      });
      return service;
    },
    suggestions() {
      suggestions ??= new PodcastSuggestions({
        db: ctx.db,
        podcasts: rt!.service(),
        log,
        ...(opts.now ? { now: opts.now } : {}),
        publish: (id) => ctx.bus.publish({ type: 'podcast', action: 'suggestion', id }),
      });
      return suggestions;
    },
    kickDownloads,
    refreshAll() {
      void ctx.scheduler
        .runTask(REFRESH_PODCASTS_JOB, 'manual', async ({ signal }) => rt!.service().refreshDue(signal, true), { key: `${REFRESH_PODCASTS_JOB}:all` })
        .done.catch(() => undefined);
    },
  };
  runtimes.set(ctx, rt);
  return rt;
}

const enabled = (ctx: AppContext) => getFeatureSettings(ctx.db).podcasts;

export function createPodcastsModule(opts: PodcastsModuleOptions = {}): AppModule {
  return (ctx) => async (app) => {
    const rt = podcastsRuntimeFor(ctx, opts);
    ctx.scheduler.register({
      name: REFRESH_PODCASTS_JOB,
      cron: '*/15 * * * *',
      handler: async ({ signal }) => (enabled(ctx) ? rt.service().refreshDue(signal) : 'podcasts are off'),
    });
    ctx.scheduler.register({
      name: DOWNLOAD_PODCASTS_JOB,
      cron: '7 * * * *',
      handler: async ({ signal }) => (enabled(ctx) ? rt.service().downloadWanted(signal) : 'podcasts are off'),
    });
    ctx.scheduler.register({
      name: PODCAST_RETENTION_JOB,
      cron: '40 3 * * *',
      handler: async () => {
        if (!enabled(ctx)) return 'podcasts are off';
        const s = rt.service();
        const played = await s.syncPlayed().catch((err: unknown) => `played state not read: ${err instanceof Error ? err.message : String(err)}`);
        return `${played}; ${await s.applyRetention()}`;
      },
    });
    await app.register(podcastRoutes(ctx, rt));
    await app.register(podcastSettingsRoutes(ctx));
  };
}

export const podcastsModule: AppModule = createPodcastsModule();
