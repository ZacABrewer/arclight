import type { CommunityCatalogueSettings, DefinitionFeedSettings } from '@arclight/shared';
import { hourlyCron } from '../../feeds.js';
import type { Scheduler } from '../../scheduler.js';
import type { CommunityCatalogue } from './community-catalogue.js';
import type { DefinitionFeed } from './definition-feed.js';
import type { IndexersService } from './service.js';

export const RSS_SYNC_JOB = 'RssSync';
export const INDEXER_STATUS_CHECK_JOB = 'IndexerStatusCheck';
export const INDEXER_STATS_CLEANUP_JOB = 'IndexerStatsCleanup';
export const DEFINITION_FEED_SYNC_JOB = 'IndexerDefinitionFeedSync';
export const COMMUNITY_CATALOGUE_SYNC_JOB = 'IndexerCommunityCatalogueSync';

export const DEFAULT_RSS_SYNC_MINUTES = 15;

export interface IndexerJobOptions {
  /** Cron for RSS sync; overrides `rssIntervalMinutes`. */
  rssCron?: string;
  /** RSS sync interval from Settings → Indexer options; 0 = on demand only. Default 15. */
  rssIntervalMinutes?: number;
  /** Cron for the status check; hourly by default. */
  statusCron?: string;
  /** Cron for pruning stats older than 90 days; nightly by default. */
  statsCleanupCron?: string;
}

/**
 * Cron for an RSS interval in minutes: `*\/N` minutes below an hour, whole hours (rounded)
 * above. null = disabled (0).
 */
export function rssCronFor(minutes: number): string | null {
  if (minutes <= 0) return null;
  if (minutes < 60) return `*/${Math.max(1, Math.round(minutes))} * * * *`;
  const hours = Math.min(24, Math.max(1, Math.round(minutes / 60)));
  return hours >= 24 ? '0 0 * * *' : `0 */${hours} * * *`;
}

export function registerIndexerJobs(scheduler: Scheduler, service: IndexersService, opts: IndexerJobOptions = {}): void {
  const rssCron = opts.rssCron ?? rssCronFor(opts.rssIntervalMinutes ?? DEFAULT_RSS_SYNC_MINUTES);
  scheduler.register({
    name: RSS_SYNC_JOB,
    ...(rssCron ? { cron: rssCron } : {}),
    handler: async ({ signal }) => {
      const releases = await service.rss({ signal });
      await service.dispatchReleases(releases);
      return `${releases.length} new releases`;
    },
  });

  scheduler.register({
    name: INDEXER_STATUS_CHECK_JOB,
    cron: opts.statusCron ?? '0 * * * *',
    handler: async ({ signal }) => service.statusCheck(signal),
  });

  scheduler.register({
    name: INDEXER_STATS_CLEANUP_JOB,
    cron: opts.statsCleanupCron ?? '20 3 * * *',
    handler: async () => `removed ${service.stats.prune()} indexer stat rows older than 90 days`,
  });
}

/** Apply a changed RSS interval to the running scheduler. */
export function rescheduleRssSync(scheduler: Scheduler, minutes: number): void {
  if (scheduler.has(RSS_SYNC_JOB)) scheduler.update(RSS_SYNC_JOB, rssCronFor(minutes));
}

/** Cron for the definition feed: null when disabled or manual. Minute 41 keeps it off the hour. */
export function definitionFeedCronFor(settings: Pick<DefinitionFeedSettings, 'enabled' | 'mode' | 'intervalHours'>): string | null {
  return settings.enabled && settings.mode === 'auto' ? hourlyCron(settings.intervalHours, 41) : null;
}

export function registerDefinitionFeedJob(scheduler: Scheduler, feed: DefinitionFeed, settings: () => DefinitionFeedSettings): void {
  const cron = definitionFeedCronFor(settings());
  scheduler.register({
    name: DEFINITION_FEED_SYNC_JOB,
    ...(cron ? { cron } : {}),
    handler: async ({ signal }) => {
      if (!settings().enabled) return 'definition feed disabled';
      const r = await feed.sync({ signal });
      if (r.notModified) return 'index not modified';
      return `${r.added.length} added, ${r.updated.length} updated, ${r.removed.length} removed, ${r.unchanged} unchanged, ${r.rejected.length} rejected`;
    },
  });
}

export function rescheduleDefinitionFeed(scheduler: Scheduler, settings: Pick<DefinitionFeedSettings, 'enabled' | 'mode' | 'intervalHours'>): void {
  if (scheduler.has(DEFINITION_FEED_SYNC_JOB)) scheduler.update(DEFINITION_FEED_SYNC_JOB, definitionFeedCronFor(settings));
}

/** Cron for the community catalogue: null when disabled. Minute 23 keeps it off the hour and off the feed. */
export function communityCatalogueCronFor(settings: Pick<CommunityCatalogueSettings, 'enabled' | 'intervalHours'>): string | null {
  return settings.enabled ? hourlyCron(settings.intervalHours, 23) : null;
}

export function registerCommunityCatalogueJob(scheduler: Scheduler, catalogue: CommunityCatalogue, settings: () => CommunityCatalogueSettings): void {
  const cron = communityCatalogueCronFor(settings());
  scheduler.register({
    name: COMMUNITY_CATALOGUE_SYNC_JOB,
    ...(cron ? { cron } : {}),
    handler: async ({ signal }) => {
      if (!settings().enabled) return 'community catalogue turned off';
      const r = await catalogue.sync({ signal });
      if (r.notModified) return `listing not modified (${r.total} definitions)`;
      return `${r.added} added, ${r.updated} updated, ${r.removed} removed, ${r.unchanged} unchanged, ${r.failed.length} failed`;
    },
  });
}

export function rescheduleCommunityCatalogue(scheduler: Scheduler, settings: Pick<CommunityCatalogueSettings, 'enabled' | 'intervalHours'>): void {
  if (scheduler.has(COMMUNITY_CATALOGUE_SYNC_JOB)) scheduler.update(COMMUNITY_CATALOGUE_SYNC_JOB, communityCatalogueCronFor(settings));
}
