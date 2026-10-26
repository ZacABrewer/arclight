import type { FeedState, FeedSummary } from '@arclight/shared';

// Self-updating data feeds (guide sync, indexer definition feed, ...). A module that pulls a
// remote data set on a schedule registers a provider here; GET /system/feeds lists them and
// the FeedStale health check warns when an enabled feed has not succeeded for three
// intervals. Known feeds whose module is not loaded show as `unregistered` placeholders.

/** What a provider reports; the registry derives `state` and the stale threshold. */
export interface FeedStatusReport {
  enabled: boolean;
  /** Sync interval in ms; null = on demand only. */
  intervalMs: number | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  pending?: number | null;
  detail?: string | null;
  /**
   * The source is known not to exist yet (e.g. the default definition feed before the repository
   * is published): an info condition shown in `detail`; the feed stays `never` and never goes stale.
   */
  notPublished?: boolean;
}

export interface FeedProvider {
  /** Stable id, e.g. `guides`, `definitions`. */
  id: string;
  name: string;
  status(): FeedStatusReport | Promise<FeedStatusReport>;
}

/** Feeds the UI always lists (as placeholders until their module registers them). */
export const KNOWN_FEEDS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'guides', name: 'Guides (custom formats & scores)' },
  { id: 'definitions', name: 'Indexer definitions' },
  { id: 'updates', name: 'Application updates' },
  { id: 'sceneMappings', name: 'Scene numbering mappings' },
];

/** A feed is stale after this many intervals without a successful sync. */
export const STALE_INTERVALS = 3;

export class FeedsRegistry {
  private readonly providers = new Map<string, FeedProvider>();
  private readonly registeredAt = new Map<string, Date>();

  /** Register (or replace) a provider. Returns an unregister function. */
  register(provider: FeedProvider, now: Date = new Date()): () => void {
    this.providers.set(provider.id, provider);
    if (!this.registeredAt.has(provider.id)) this.registeredAt.set(provider.id, now);
    return () => {
      if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id);
    };
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  /** Every registered feed plus placeholders for known ones, known ones first. */
  async summary(now: Date = new Date()): Promise<FeedSummary[]> {
    const ids = [...KNOWN_FEEDS.map((f) => f.id), ...[...this.providers.keys()].filter((id) => !KNOWN_FEEDS.some((f) => f.id === id))];
    const out: FeedSummary[] = [];
    for (const id of ids) {
      const provider = this.providers.get(id);
      if (!provider) {
        const known = KNOWN_FEEDS.find((f) => f.id === id);
        out.push(placeholder(id, known?.name ?? id));
        continue;
      }
      try {
        out.push(summarize(provider.id, provider.name, await provider.status(), now, this.registeredAt.get(provider.id) ?? now));
      } catch (err) {
        out.push({ ...placeholder(provider.id, provider.name), registered: true, state: 'error', lastError: errorMessage(err) });
      }
    }
    return out;
  }
}

function placeholder(id: string, name: string): FeedSummary {
  return {
    id,
    name,
    registered: false,
    enabled: false,
    state: 'unregistered',
    intervalMs: null,
    staleAfterMs: null,
    lastSyncAt: null,
    lastSuccessAt: null,
    lastError: null,
    pending: null,
    detail: null,
  };
}

/**
 * Derive the state of one feed from its report. A feed that never succeeded counts from
 * `since` (when it was registered), so a feed failing from the first attempt goes stale too.
 */
export function summarize(id: string, name: string, r: FeedStatusReport, now: Date, since: Date = now): FeedSummary {
  const staleAfterMs = r.intervalMs === null ? null : r.intervalMs * STALE_INTERVALS;
  const reference = r.lastSuccessAt === null ? since.getTime() : Date.parse(r.lastSuccessAt);
  const overdue = staleAfterMs !== null && now.getTime() - reference > staleAfterMs;
  let state: FeedState;
  if (!r.enabled) state = 'disabled';
  else if (r.notPublished && r.lastSuccessAt === null) state = 'never';
  else if (overdue) state = 'stale';
  else if (r.lastSuccessAt === null) state = r.lastError ? 'error' : 'never';
  else if (r.lastError && r.lastSyncAt !== null && Date.parse(r.lastSyncAt) > Date.parse(r.lastSuccessAt)) state = 'error';
  else state = 'ok';
  return {
    id,
    name,
    registered: true,
    enabled: r.enabled,
    state,
    intervalMs: r.intervalMs,
    staleAfterMs,
    lastSyncAt: r.lastSyncAt,
    lastSuccessAt: r.lastSuccessAt,
    lastError: r.lastError,
    pending: r.pending ?? null,
    detail: r.detail ?? null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// One registry per app context (keyed weakly so test contexts do not leak).
const registries = new WeakMap<object, FeedsRegistry>();

/** The registry of an app context; modules call `feedsRegistry(ctx).register(...)`. */
export function feedsRegistry(ctx: object): FeedsRegistry {
  let registry = registries.get(ctx);
  if (!registry) {
    registry = new FeedsRegistry();
    registries.set(ctx, registry);
  }
  return registry;
}

/** Cron for an interval in hours: every N hours below a day, every N days (at 04:MM) above. */
export function hourlyCron(hours: number, minute = 0): string {
  const h = Math.max(1, Math.round(hours));
  if (h < 24) return `${minute} */${h} * * *`;
  const days = Math.max(1, Math.round(h / 24));
  return days === 1 ? `${minute} 4 * * *` : `${minute} 4 */${days} * *`;
}
