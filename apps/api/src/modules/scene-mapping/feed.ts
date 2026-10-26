import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  DEFAULT_SCENE_MAPPING_FEED_URL,
  SCENE_MAPPING_FEED_SCHEMA_VERSION,
  SceneMappingFeedFile,
  SceneMappingFeedSeries,
  SceneMappingInput,
  SeriesListQuery,
  type SceneMappingFeedStatus,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { settings } from '../../db/schema.js';
import type { FeedStatusReport } from '../../feeds.js';
import { libraryService } from '../library/index.js';
import { sceneMappings } from './schema.js';
import { SceneMappingError } from './service.js';

// Community scene-mapping feed: one JSON file in the Arclight repository
// (DEFAULT_SCENE_MAPPING_FEED_URL). Format:
//
//   { "schemaVersion": 1, "generatedAt": "...",
//     "series": [ { "tvdbId": 267440, "tmdbId": 1429, "title": "...",
//                   "mappings": [ { "kind": "season", "sceneSeason": 2, "tvdbSeason": 1,
//                                   "sceneEpisode": 1, "tvdbEpisode": 26, "comment": "" }, ... ] } ] }
//
// Each mapping is a SceneMappingInput. Series are matched to the library by tvdbId, then tmdbId;
// every sync replaces all `feed` rows (manual rules are never touched). A 404 means the file is
// not published yet: an info condition, the feed is neither an error nor stale.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** settings-table key of the sync state (not a settings section; like the calendar ICS token). */
export const SCENE_MAPPING_FEED_STATE_KEY = 'sceneMappingFeed';
export const SCENE_MAPPING_FEED_NOT_PUBLISHED = 'scene mapping feed not published yet';
/** Daily sync. */
export const SCENE_MAPPING_FEED_INTERVAL_MS = 24 * 3_600_000;

interface FeedState {
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  notPublished: boolean;
  etag: string | null;
  feedSeries: number;
  matchedSeries: number;
  mappings: number;
  rejected: number;
}

const EMPTY: FeedState = {
  lastSyncAt: null,
  lastSuccessAt: null,
  lastError: null,
  notPublished: false,
  etag: null,
  feedSeries: 0,
  matchedSeries: 0,
  mappings: 0,
  rejected: 0,
};

export interface SceneMappingFeedOptions {
  db: Db;
  url?: string;
  fetch?: FetchLike;
  log?: Logger;
  now?: () => Date;
  timeoutMs?: number;
}

export class SceneMappingFeed {
  readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private running: Promise<SceneMappingFeedStatus> | undefined;

  constructor(private readonly opts: SceneMappingFeedOptions) {
    this.url = opts.url ?? DEFAULT_SCENE_MAPPING_FEED_URL;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => new Date());
  }

  private readState(): FeedState {
    const row = this.opts.db.select().from(settings).where(eq(settings.key, SCENE_MAPPING_FEED_STATE_KEY)).get();
    return { ...EMPTY, ...((row?.value as Partial<FeedState> | undefined) ?? {}) };
  }

  private writeState(state: FeedState): void {
    const updatedAt = this.now().toISOString();
    this.opts.db
      .insert(settings)
      .values({ key: SCENE_MAPPING_FEED_STATE_KEY, value: state, updatedAt })
      .onConflictDoUpdate({ target: settings.key, set: { value: state, updatedAt } })
      .run();
  }

  status(): SceneMappingFeedStatus {
    const s = this.readState();
    return {
      url: this.url,
      lastSyncAt: s.lastSyncAt,
      lastSuccessAt: s.lastSuccessAt,
      lastError: s.lastError,
      notPublished: s.notPublished,
      feedSeries: s.feedSeries,
      matchedSeries: s.matchedSeries,
      mappings: s.mappings,
      rejected: s.rejected,
    };
  }

  /** Report for the feeds registry. */
  feedStatus(): FeedStatusReport {
    const s = this.readState();
    if (s.notPublished && s.lastSuccessAt === null) {
      return {
        enabled: true,
        intervalMs: SCENE_MAPPING_FEED_INTERVAL_MS,
        lastSyncAt: s.lastSyncAt,
        lastSuccessAt: null,
        lastError: null,
        notPublished: true,
        detail: `${SCENE_MAPPING_FEED_NOT_PUBLISHED} (${this.url} returned 404); manual mappings still apply`,
      };
    }
    return {
      enabled: true,
      intervalMs: SCENE_MAPPING_FEED_INTERVAL_MS,
      lastSyncAt: s.lastSyncAt,
      lastSuccessAt: s.lastSuccessAt,
      lastError: s.lastError,
      detail: `${s.mappings} mapping${s.mappings === 1 ? '' : 's'} for ${s.matchedSeries} library series (${s.feedSeries} in feed)${s.rejected ? `, ${s.rejected} rejected` : ''}`,
    };
  }

  /** Concurrent calls share one run. Throws SceneMappingError UPSTREAM on failure (state records it). */
  sync(opts: { signal?: AbortSignal } = {}): Promise<SceneMappingFeedStatus> {
    if (this.running) return this.running;
    const run = this.runSync(opts.signal).finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  private async runSync(signal?: AbortSignal): Promise<SceneMappingFeedStatus> {
    const state = this.readState();
    const startedAt = this.now().toISOString();
    const fail = (message: string): never => {
      this.writeState({ ...state, lastSyncAt: startedAt, lastError: message });
      this.opts.log?.warn({ url: this.url }, `scene mapping feed sync failed: ${message}`);
      throw new SceneMappingError('UPSTREAM', message);
    };

    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        // No conditional request: series added since the last sync need the rules re-applied.
        headers: { 'user-agent': 'Arclight' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      return fail(`${this.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 304) {
      this.writeState({ ...state, lastSyncAt: startedAt, lastSuccessAt: startedAt, lastError: null });
      return this.status();
    }
    if (res.status === 404) {
      this.writeState({ ...state, lastSyncAt: startedAt, lastError: null, notPublished: true });
      this.opts.log?.info({ url: this.url }, SCENE_MAPPING_FEED_NOT_PUBLISHED);
      return this.status();
    }
    if (!res.ok) return fail(`${this.url}: HTTP ${res.status}`);

    let raw: unknown;
    try {
      raw = JSON.parse(await res.text()) as unknown;
    } catch {
      return fail(`${this.url}: not JSON`);
    }
    const doc = SceneMappingFeedFile.safeParse(raw);
    if (!doc.success) return fail(`${this.url}: invalid feed file (${doc.error.issues[0]?.message ?? 'unknown'})`);
    if (doc.data.schemaVersion < 1 || doc.data.schemaVersion > SCENE_MAPPING_FEED_SCHEMA_VERSION) {
      return fail(`${this.url}: schemaVersion ${doc.data.schemaVersion} is not supported (this build reads ${SCENE_MAPPING_FEED_SCHEMA_VERSION})`);
    }

    const library = libraryService.listSeries(this.opts.db, SeriesListQuery.parse({ includeStatistics: false }));
    const byTvdb = new Map(library.filter((s) => s.tvdbId != null).map((s) => [s.tvdbId!, s.id]));
    const byTmdb = new Map(library.map((s) => [s.tmdbId, s.id]));
    let rejected = 0;
    const matched = new Set<number>();
    const rows: Array<typeof sceneMappings.$inferInsert> = [];
    for (const entry of doc.data.series) {
      const series = SceneMappingFeedSeries.safeParse(entry);
      if (!series.success) {
        rejected++;
        continue;
      }
      const s = series.data;
      const seriesId = (s.tvdbId !== undefined ? byTvdb.get(s.tvdbId) : undefined) ?? (s.tmdbId !== undefined ? byTmdb.get(s.tmdbId) : undefined);
      for (const m of s.mappings) {
        const rule = SceneMappingInput.safeParse(m);
        if (!rule.success) {
          rejected++;
          continue;
        }
        if (seriesId === undefined) continue;
        matched.add(seriesId);
        rows.push({ ...rule.data, seriesId, source: 'feed' });
      }
    }

    this.opts.db.transaction((tx) => {
      tx.delete(sceneMappings).where(eq(sceneMappings.source, 'feed')).run();
      for (const row of rows) tx.insert(sceneMappings).values(row).run();
    });
    this.writeState({
      lastSyncAt: startedAt,
      lastSuccessAt: startedAt,
      lastError: null,
      notPublished: false,
      etag: res.headers.get('etag'),
      feedSeries: doc.data.series.length,
      matchedSeries: matched.size,
      mappings: rows.length,
      rejected,
    });
    this.opts.log?.info({ mappings: rows.length, series: matched.size, rejected }, 'scene mapping feed synced');
    return this.status();
  }
}
