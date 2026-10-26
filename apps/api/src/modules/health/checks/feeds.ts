import { finding, type HealthCheckDef } from '../types.js';

function ago(iso: string, now: Date): string {
  const hours = Math.round((now.getTime() - Date.parse(iso)) / 3_600_000);
  return hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
}

/**
 * An enabled data feed (guides, indexer definitions, ...) has gone three sync intervals
 * without a success (the feeds registry decides `stale`).
 */
export const feedStaleCheck: HealthCheckDef = {
  id: 'FeedStale',
  async run(deps) {
    if (!deps.feeds) return [];
    const now = deps.now();
    const feeds = await deps.feeds();
    return feeds
      .filter((f) => f.state === 'stale')
      .map((f) => {
        const since = f.lastSuccessAt ? `has not updated for ${ago(f.lastSuccessAt, now)}` : 'has never synced successfully';
        const why = f.lastError ? ` Last error: ${f.lastError}` : '';
        return finding(this.id, 'warning', `${f.name} feed ${since}.${why}`, 'feed-stale');
      });
  },
};

/**
 * The community indexer catalogue is on and synced, but nothing in it loads (an empty listing,
 * or a source URL that serves files this engine cannot read). Staleness is FeedStale's job.
 */
export const indexerCatalogueEmptyCheck: HealthCheckDef = {
  id: 'IndexerCatalogueEmpty',
  async run(deps) {
    if (!deps.indexerCatalogue) return [];
    const c = await deps.indexerCatalogue();
    if (!c.enabled || c.lastSuccessAt === null || c.supported > 0) return [];
    const what = c.files === 0 ? 'has no definitions' : `has ${c.files} definition files but none of them load`;
    return [finding(this.id, 'warning', `The community indexer catalogue ${what}. Check the source URL in Settings > Indexer catalogue.`, 'indexer-catalogue-empty')];
  },
};
