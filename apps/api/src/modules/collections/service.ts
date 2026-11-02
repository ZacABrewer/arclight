import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  isMediaBrowserKind,
  SmartCollectionInput,
  type CollectionItem,
  type CollectionPreview,
  type CollectionsSettings,
  type CollectionSyncResult,
  type CollectionSyncState,
  type LeavingSoon,
  type MediaImage,
  type MediaServerConfig,
  type Ratings,
  type SmartCollection,
  type SmartCollectionCriteria,
  type SmartCollectionInputParsed,
  type SmartCollectionList,
} from '@arclight/shared';
import type { MediaBrowserServerClient, MediaServerItem } from '@arclight/media-servers';
import type { Db } from '../../db/index.js';
import { mediaFiles, movies, retentionCandidates, retentionRules, series, watchState } from '../../db/schema.js';
import { getSection } from '../settings/service.js';
import { collectionSyncs, smartCollections, type CollectionSyncRow, type SmartCollectionRow } from './schema.js';

// Leaving Soon and smart collections: which library titles belong in each, and keeping a
// matching collection (BoxSet) on every chosen Jellyfin/Emby server. Arclight owns the
// collections it created (collection_syncs); it never touches other collections, except one
// with exactly the same name, which it adopts instead of creating a duplicate.

const DAY_MS = 24 * 60 * 60_000;
export const LEAVING_SOON_KEY = 'leavingSoon';
const smartKey = (id: number) => `smart:${id}`;
/** How long a fetched TMDB list is reused. */
const LIST_TTL_MS = 6 * 60 * 60_000;

export class CollectionsError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'VALIDATION',
    message: string,
  ) {
    super(message);
    this.name = 'CollectionsError';
  }
}

/** TMDB ids on a list, in list order. */
export type ListSource = (list: SmartCollectionList, kind: 'movie' | 'tv') => Promise<number[]>;

export interface CollectionServer {
  config: MediaServerConfig;
  client: Pick<
    MediaBrowserServerClient,
    'listItems' | 'collections' | 'collectionItemIds' | 'createCollection' | 'addToCollection' | 'removeFromCollection' | 'deleteCollection' | 'setCollectionOverview'
  >;
}

export interface CollectionsServiceOptions {
  db: Db;
  /** Every stored media server connection (any kind; disabled ones too). */
  servers: () => MediaServerConfig[];
  /** A Jellyfin/Emby client for a connection. */
  client: (config: MediaServerConfig) => CollectionServer['client'];
  lists?: ListSource;
  now?: () => Date;
}

/** A library title as the rules see it. */
interface Candidate {
  mediaType: 'movie' | 'series';
  id: number;
  tmdbId: number;
  tvdbId: number | null;
  imdbId: string | null;
  title: string;
  sortTitle: string;
  year: number;
  genres: string[];
  studio: string | null;
  collectionTmdbId: number | null;
  rating: number | null;
  added: string;
  images: MediaImage[];
}

interface Desired {
  key: string;
  name: string;
  items: Candidate[];
  overview?: string;
}

function rating(r: Ratings | null | undefined): number | null {
  return r?.['tmdb']?.value ?? r?.['imdb']?.value ?? null;
}

function poster(images: readonly MediaImage[]): string | null {
  const p = images.find((i) => i.coverType === 'poster');
  if (!p) return null;
  if (p.remoteUrl) return p.remoteUrl;
  return /^https?:\/\//.test(p.url) ? p.url : null;
}

function lower(values: readonly string[]): Set<string> {
  return new Set(values.map((v) => v.trim().toLowerCase()));
}

export class CollectionsService {
  private readonly db: Db;
  private readonly servers: () => MediaServerConfig[];
  private readonly client: CollectionsServiceOptions['client'];
  private readonly lists: ListSource | undefined;
  private readonly now: () => Date;
  private readonly listCache = new Map<string, { at: number; ids: number[] }>();

  constructor(opts: CollectionsServiceOptions) {
    this.db = opts.db;
    this.servers = opts.servers;
    this.client = opts.client;
    this.lists = opts.lists;
    this.now = opts.now ?? (() => new Date());
  }

  settings(): CollectionsSettings {
    return getSection(this.db, 'collections');
  }

  // ---- rules ---------------------------------------------------------------------------

  private toView(row: SmartCollectionRow, syncs: CollectionSyncRow[]): SmartCollection {
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      mediaType: row.mediaType,
      criteria: row.criteria,
      sort: row.sort,
      limit: row.limit,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sync: this.syncViews(syncs.filter((s) => s.collectionKey === smartKey(row.id))),
    };
  }

  private syncViews(rows: CollectionSyncRow[]): CollectionSyncState[] {
    const names = new Map(this.servers().map((s) => [s.id, s.name]));
    return rows.map((r) => ({
      serverId: r.serverId,
      serverName: names.get(r.serverId) ?? r.serverId,
      remoteId: r.remoteId,
      itemCount: r.itemCount,
      missing: r.missing,
      lastSyncAt: r.lastSyncAt,
      lastError: r.lastError,
    }));
  }

  list(): SmartCollection[] {
    const syncs = this.db.select().from(collectionSyncs).all();
    return this.db
      .select()
      .from(smartCollections)
      .orderBy(asc(smartCollections.name))
      .all()
      .map((r) => this.toView(r, syncs));
  }

  get(id: number): SmartCollection {
    const row = this.db.select().from(smartCollections).where(eq(smartCollections.id, id)).get();
    if (!row) throw new CollectionsError('NOT_FOUND', `smart collection ${id} not found`);
    return this.toView(row, this.db.select().from(collectionSyncs).where(eq(collectionSyncs.collectionKey, smartKey(id))).all());
  }

  private validate(input: SmartCollectionInputParsed): void {
    const c = input.criteria;
    if (c.yearFrom !== null && c.yearTo !== null && c.yearFrom > c.yearTo) throw new CollectionsError('VALIDATION', 'yearFrom is after yearTo');
    if (input.name.trim().toLowerCase() === this.settings().leavingSoon.name.trim().toLowerCase()) {
      throw new CollectionsError('VALIDATION', 'that name is used by the Leaving Soon collection');
    }
  }

  private assertUniqueName(name: string, exceptId?: number): void {
    const clash = this.db
      .select({ id: smartCollections.id })
      .from(smartCollections)
      .where(sql`lower(${smartCollections.name}) = ${name.trim().toLowerCase()}`)
      .all()
      .some((r) => r.id !== exceptId);
    if (clash) throw new CollectionsError('VALIDATION', `a smart collection named "${name}" already exists`);
  }

  create(raw: unknown): SmartCollection {
    const input = SmartCollectionInput.parse(raw);
    this.validate(input);
    this.assertUniqueName(input.name);
    const now = this.now().toISOString();
    const row = this.db
      .insert(smartCollections)
      .values({ ...input, name: input.name.trim(), createdAt: now, updatedAt: now })
      .returning()
      .get();
    return this.get(row.id);
  }

  update(id: number, raw: unknown): SmartCollection {
    this.get(id);
    const input = SmartCollectionInput.parse(raw);
    this.validate(input);
    this.assertUniqueName(input.name, id);
    this.db
      .update(smartCollections)
      .set({ ...input, name: input.name.trim(), updatedAt: this.now().toISOString() })
      .where(eq(smartCollections.id, id))
      .run();
    return this.get(id);
  }

  /** Deletes the rule; the next sync removes its collections from the servers. */
  delete(id: number): void {
    this.get(id);
    this.db.delete(smartCollections).where(eq(smartCollections.id, id)).run();
  }

  // ---- evaluation ----------------------------------------------------------------------

  /** Library titles with files on disk (what a media server can have). */
  private library(mediaType: 'movie' | 'series' | 'all'): Candidate[] {
    const out: Candidate[] = [];
    if (mediaType !== 'series') {
      for (const m of this.db.select().from(movies).where(eq(movies.hasFile, true)).all()) {
        out.push({
          mediaType: 'movie',
          id: m.id,
          tmdbId: m.tmdbId,
          tvdbId: null,
          imdbId: m.imdbId,
          title: m.title,
          sortTitle: m.sortTitle,
          year: m.year,
          genres: m.genres ?? [],
          studio: m.studio,
          collectionTmdbId: m.collection?.tmdbId ?? null,
          rating: rating(m.ratings),
          added: m.added,
          images: m.images ?? [],
        });
      }
    }
    if (mediaType !== 'movie') {
      const withFiles = new Set(
        this.db
          .selectDistinct({ id: mediaFiles.seriesId })
          .from(mediaFiles)
          .where(eq(mediaFiles.mediaType, 'series'))
          .all()
          .flatMap((r) => (r.id !== null ? [r.id] : [])),
      );
      for (const s of this.db.select().from(series).all()) {
        if (!withFiles.has(s.id)) continue;
        out.push({
          mediaType: 'series',
          id: s.id,
          tmdbId: s.tmdbId,
          tvdbId: s.tvdbId,
          imdbId: s.imdbId,
          title: s.title,
          sortTitle: s.sortTitle,
          year: s.year,
          genres: s.genres ?? [],
          studio: s.network,
          collectionTmdbId: null,
          rating: rating(s.ratings),
          added: s.added,
          images: s.images ?? [],
        });
      }
    }
    return out;
  }

  /** Server-wide watch facts per title: played by someone, partly watched, total plays. */
  private watchFacts(): Map<string, { played: boolean; inProgress: boolean; plays: number }> {
    const out = new Map<string, { played: boolean; inProgress: boolean; plays: number }>();
    const get = (key: string) => {
      let f = out.get(key);
      if (!f) {
        f = { played: false, inProgress: false, plays: 0 };
        out.set(key, f);
      }
      return f;
    };
    for (const r of this.db
      .select({
        itemType: watchState.itemType,
        movieId: watchState.movieId,
        seriesId: watchState.seriesId,
        played: watchState.played,
        playCount: watchState.playCount,
        positionMs: watchState.positionMs,
        episodesPlayed: watchState.episodesPlayed,
      })
      .from(watchState)
      .where(inArray(watchState.itemType, ['movie', 'series', 'episode']))
      .all()) {
      if (r.itemType === 'movie' && r.movieId !== null) {
        const f = get(`movie:${r.movieId}`);
        f.played ||= r.played;
        f.inProgress ||= !r.played && r.positionMs > 0;
        f.plays += r.playCount;
      } else if (r.itemType === 'series' && r.seriesId !== null) {
        const f = get(`series:${r.seriesId}`);
        f.played ||= r.played;
        f.inProgress ||= !r.played && (r.episodesPlayed ?? 0) > 0;
      } else if (r.itemType === 'episode' && r.seriesId !== null) {
        const f = get(`series:${r.seriesId}`);
        f.plays += r.playCount;
        f.inProgress ||= !r.played && r.positionMs > 0;
      }
    }
    return out;
  }

  private async listIds(list: SmartCollectionList, kind: 'movie' | 'tv'): Promise<number[]> {
    if (!this.lists) return [];
    const key = `${list}:${kind}`;
    const cached = this.listCache.get(key);
    if (cached && this.now().getTime() - cached.at < LIST_TTL_MS) return cached.ids;
    const ids = await this.lists(list, kind);
    this.listCache.set(key, { at: this.now().getTime(), ids });
    return ids;
  }

  /** The titles a rule selects, sorted and limited. */
  async evaluate(raw: SmartCollectionInputParsed | unknown): Promise<Candidate[]> {
    const rule = SmartCollectionInput.parse(raw);
    const c: SmartCollectionCriteria = rule.criteria;
    const genres = lower(c.genres);
    const excluded = lower(c.excludeGenres);
    const studios = lower(c.studios);
    const collections = new Set(c.tmdbCollectionIds);
    const addedSince = c.addedWithinDays !== null ? new Date(this.now().getTime() - c.addedWithinDays * DAY_MS).toISOString() : null;
    const facts = c.watchStatus !== 'any' || rule.sort === 'plays' ? this.watchFacts() : null;
    let rank: Map<string, number> | null = null;
    if (c.list) {
      rank = new Map();
      if (rule.mediaType !== 'series') (await this.listIds(c.list, 'movie')).forEach((id, i) => rank!.set(`movie:${id}`, i));
      if (rule.mediaType !== 'movie') (await this.listIds(c.list, 'tv')).forEach((id, i) => rank!.set(`series:${id}`, i));
    }

    const matches = this.library(rule.mediaType).filter((t) => {
      const g = lower(t.genres);
      if (genres.size > 0) {
        const hit = [...genres].filter((x) => g.has(x)).length;
        if (c.genreMatch === 'all' ? hit < genres.size : hit === 0) return false;
      }
      if ([...excluded].some((x) => g.has(x))) return false;
      if (c.yearFrom !== null && t.year < c.yearFrom) return false;
      if (c.yearTo !== null && t.year > c.yearTo) return false;
      if (studios.size > 0 && !(t.studio && studios.has(t.studio.trim().toLowerCase()))) return false;
      if (collections.size > 0 && !(t.collectionTmdbId !== null && collections.has(t.collectionTmdbId))) return false;
      if (c.minRating !== null && !(t.rating !== null && t.rating >= c.minRating)) return false;
      if (addedSince && t.added < addedSince) return false;
      if (rank && !rank.has(`${t.mediaType}:${t.tmdbId}`)) return false;
      if (facts && c.watchStatus !== 'any') {
        const f = facts.get(`${t.mediaType}:${t.id}`);
        if (c.watchStatus === 'unwatched' && f && (f.played || f.inProgress || f.plays > 0)) return false;
        if (c.watchStatus === 'watched' && !f?.played) return false;
        if (c.watchStatus === 'inProgress' && !f?.inProgress) return false;
      }
      return true;
    });

    const by = {
      added: (a: Candidate, b: Candidate) => b.added.localeCompare(a.added),
      title: (a: Candidate, b: Candidate) => a.sortTitle.localeCompare(b.sortTitle),
      year: (a: Candidate, b: Candidate) => b.year - a.year,
      rating: (a: Candidate, b: Candidate) => (b.rating ?? -1) - (a.rating ?? -1),
      plays: (a: Candidate, b: Candidate) => (facts?.get(`${b.mediaType}:${b.id}`)?.plays ?? 0) - (facts?.get(`${a.mediaType}:${a.id}`)?.plays ?? 0),
      list: (a: Candidate, b: Candidate) =>
        (rank?.get(`${a.mediaType}:${a.tmdbId}`) ?? Number.MAX_SAFE_INTEGER) - (rank?.get(`${b.mediaType}:${b.tmdbId}`) ?? Number.MAX_SAFE_INTEGER),
    }[rule.sort];
    matches.sort((a, b) => by(a, b) || a.sortTitle.localeCompare(b.sortTitle));
    return rule.limit !== null ? matches.slice(0, rule.limit) : matches;
  }

  private item(t: Candidate, removeAt: string | null = null): CollectionItem {
    return { mediaType: t.mediaType, id: t.id, tmdbId: t.tmdbId, title: t.title, year: t.year, posterUrl: poster(t.images), removeAt };
  }

  async preview(raw: unknown, limit = 100): Promise<CollectionPreview> {
    const items = await this.evaluate(raw);
    return { total: items.length, items: items.slice(0, limit).map((t) => this.item(t)) };
  }

  async items(id: number, limit = 200): Promise<CollectionPreview> {
    return this.preview(this.get(id), limit);
  }

  // ---- Leaving Soon --------------------------------------------------------------------

  /**
   * Titles a live (enabled, not dry-run) retention rule will delete within `days`: staged
   * candidates (pending, or failed and retried) whose action removes files, soonest first.
   */
  leavingSoonItems(days = this.settings().leavingSoon.days): (CollectionItem & { candidate: Candidate })[] {
    const until = new Date(this.now().getTime() + days * DAY_MS).toISOString();
    const rows = this.db
      .select({ mediaType: retentionCandidates.mediaType, mediaId: retentionCandidates.mediaId, applyAfter: retentionCandidates.applyAfter })
      .from(retentionCandidates)
      .innerJoin(retentionRules, eq(retentionCandidates.ruleId, retentionRules.id))
      .where(
        and(
          inArray(retentionCandidates.status, ['pending', 'failed']),
          inArray(retentionCandidates.action, ['deleteFiles', 'deleteItem']),
          eq(retentionRules.enabled, true),
          eq(retentionRules.dryRun, false),
          sql`${retentionCandidates.applyAfter} <= ${until}`,
        ),
      )
      .orderBy(asc(retentionCandidates.applyAfter))
      .all();
    if (rows.length === 0) return [];
    const lib = new Map(this.library('all').map((t) => [`${t.mediaType}:${t.id}`, t]));
    const seen = new Set<string>();
    const out: (CollectionItem & { candidate: Candidate })[] = [];
    for (const r of rows) {
      const key = `${r.mediaType}:${r.mediaId}`;
      const t = lib.get(key);
      if (!t || seen.has(key)) continue;
      seen.add(key);
      // Overdue candidates are removed by the next sweep: show today, not a date in the past.
      const removeAt = r.applyAfter < this.now().toISOString() ? this.now().toISOString() : r.applyAfter;
      out.push({ ...this.item(t, removeAt), candidate: t });
    }
    return out;
  }

  leavingSoon(): LeavingSoon {
    const s = this.settings().leavingSoon;
    return {
      enabled: s.enabled,
      days: s.days,
      name: s.name,
      items: this.leavingSoonItems(s.days).map(({ candidate: _c, ...i }) => i),
      sync: this.syncViews(this.db.select().from(collectionSyncs).where(eq(collectionSyncs.collectionKey, LEAVING_SOON_KEY)).all()),
    };
  }

  // ---- sync ----------------------------------------------------------------------------

  /** The Jellyfin/Emby servers collections go to. */
  targetServers(): MediaServerConfig[] {
    const chosen = this.settings().serverIds;
    return this.servers().filter((s) => s.enabled && isMediaBrowserKind(s.kind) && (chosen.length === 0 || chosen.includes(s.id)));
  }

  private async desired(): Promise<{ wanted: Desired[]; errors: string[] }> {
    const wanted: Desired[] = [];
    const errors: string[] = [];
    const ls = this.settings().leavingSoon;
    if (ls.enabled) {
      const items = this.leavingSoonItems(ls.days);
      const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const overview = items.length
        ? `Leaving the library soon:\n${items.map((i) => `${i.title} (${i.year}) - ${fmt(i.removeAt!)}`).join('\n')}`
        : 'Nothing is leaving the library soon.';
      wanted.push({ key: LEAVING_SOON_KEY, name: ls.name, items: items.map((i) => i.candidate), overview });
    }
    for (const rule of this.db.select().from(smartCollections).where(eq(smartCollections.enabled, true)).all()) {
      try {
        wanted.push({ key: smartKey(rule.id), name: rule.name, items: await this.evaluate(rule) });
      } catch (err) {
        errors.push(`${rule.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { wanted, errors };
  }

  /** Brings every target server in line with the wanted collections and removes stale ones. */
  async sync(): Promise<CollectionSyncResult> {
    const result: CollectionSyncResult = { collections: 0, servers: 0, added: 0, removed: 0, created: 0, deleted: 0, errors: [] };
    const { wanted, errors } = await this.desired();
    result.errors.push(...errors);
    result.collections = wanted.length;
    const targets = this.targetServers();
    result.servers = targets.length;
    const targetIds = new Set(targets.map((s) => s.id));
    const wantedKeys = new Set(wanted.map((w) => w.key));
    const known = new Set(this.servers().map((s) => s.id));

    // Collections no longer wanted (rule deleted/disabled, Leaving Soon off, server deselected).
    for (const row of this.db.select().from(collectionSyncs).all()) {
      if (wantedKeys.has(row.collectionKey) && targetIds.has(row.serverId)) continue;
      const config = this.servers().find((s) => s.id === row.serverId);
      if (row.remoteId && config && config.enabled && isMediaBrowserKind(config.kind)) {
        try {
          await this.client(config).deleteCollection(row.remoteId);
          result.deleted++;
        } catch (err) {
          result.errors.push(`${config.name}: removing "${row.name}": ${err instanceof Error ? err.message : String(err)}`);
          continue; // keep the row and retry next time
        }
      } else if (config && known.has(row.serverId) && row.remoteId) {
        continue; // server disabled for now: remove it once it is back
      }
      this.db.delete(collectionSyncs).where(eq(collectionSyncs.id, row.id)).run();
    }

    for (const config of targets) {
      let client: CollectionServer['client'];
      try {
        client = this.client(config);
      } catch (err) {
        result.errors.push(`${config.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      let index: Map<string, string>;
      let existing: Map<string, string>;
      try {
        index = await this.remoteIndex(client, wanted);
        existing = new Map((await client.collections()).map((c) => [c.name.trim().toLowerCase(), c.id]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${config.name}: ${message}`);
        for (const w of wanted) this.recordError(w, config.id, message);
        continue;
      }
      for (const w of wanted) {
        try {
          const r = await this.syncOne(client, config.id, w, index, existing);
          result.added += r.added;
          result.removed += r.removed;
          result.created += r.created;
          result.deleted += r.deleted;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(`${config.name}: "${w.name}": ${message}`);
          this.recordError(w, config.id, message);
        }
      }
    }
    return result;
  }

  /** Remote item id per `movie:<tmdb>` / `series:<tmdb>` (also tvdb and imdb keys). */
  private async remoteIndex(client: CollectionServer['client'], wanted: Desired[]): Promise<Map<string, string>> {
    const kinds = new Set(wanted.flatMap((w) => w.items.map((i) => i.mediaType)));
    const index = new Map<string, string>();
    const add = (kind: string, item: MediaServerItem) => {
      if (item.ids.tmdbId) index.set(`${kind}:tmdb:${item.ids.tmdbId}`, item.id);
      if (item.ids.tvdbId) index.set(`${kind}:tvdb:${item.ids.tvdbId}`, item.id);
      if (item.ids.imdbId) index.set(`${kind}:imdb:${item.ids.imdbId.toLowerCase()}`, item.id);
    };
    for (const kind of kinds) for (const item of await client.listItems(kind)) add(kind, item);
    return index;
  }

  private remoteId(index: Map<string, string>, t: Candidate): string | undefined {
    return (
      index.get(`${t.mediaType}:tmdb:${t.tmdbId}`) ??
      (t.tvdbId ? index.get(`${t.mediaType}:tvdb:${t.tvdbId}`) : undefined) ??
      (t.imdbId ? index.get(`${t.mediaType}:imdb:${t.imdbId.toLowerCase()}`) : undefined)
    );
  }

  private row(key: string, serverId: string): CollectionSyncRow | undefined {
    return this.db
      .select()
      .from(collectionSyncs)
      .where(and(eq(collectionSyncs.collectionKey, key), eq(collectionSyncs.serverId, serverId)))
      .get();
  }

  private recordError(w: Desired, serverId: string, message: string): void {
    const row = this.row(w.key, serverId);
    const now = this.now().toISOString();
    if (row) this.db.update(collectionSyncs).set({ lastError: message, lastSyncAt: now }).where(eq(collectionSyncs.id, row.id)).run();
    else this.db.insert(collectionSyncs).values({ collectionKey: w.key, serverId, name: w.name, lastError: message, lastSyncAt: now }).run();
  }

  private async syncOne(
    client: CollectionServer['client'],
    serverId: string,
    w: Desired,
    index: Map<string, string>,
    existing: Map<string, string>,
  ): Promise<{ added: number; removed: number; created: number; deleted: number }> {
    const out = { added: 0, removed: 0, created: 0, deleted: 0 };
    const ids: string[] = [];
    let missing = 0;
    for (const t of w.items) {
      const id = this.remoteId(index, t);
      if (id) ids.push(id);
      else missing++;
    }
    const want = [...new Set(ids)];
    let row = this.row(w.key, serverId);
    let remoteId = row?.remoteId ?? null;

    // Renamed: the old collection goes, one with the new name takes its place.
    if (row && remoteId && row.name !== w.name) {
      await client.deleteCollection(remoteId);
      out.deleted++;
      remoteId = null;
    }
    let current: string[] | null = remoteId ? await client.collectionItemIds(remoteId) : null;
    if (current === null) {
      remoteId = null;
      const adopt = existing.get(w.name.trim().toLowerCase());
      if (adopt) {
        remoteId = adopt;
        current = (await client.collectionItemIds(adopt)) ?? null;
      }
    }
    if (remoteId === null || current === null) {
      if (want.length > 0) {
        remoteId = await client.createCollection(w.name, want);
        existing.set(w.name.trim().toLowerCase(), remoteId);
        out.created++;
        out.added += want.length;
        current = want;
      } else {
        remoteId = null;
        current = [];
      }
    } else {
      const have = new Set(current);
      const keep = new Set(want);
      const toAdd = want.filter((id) => !have.has(id));
      const toRemove = current.filter((id) => !keep.has(id));
      if (toAdd.length) await client.addToCollection(remoteId, toAdd);
      if (toRemove.length) await client.removeFromCollection(remoteId, toRemove);
      out.added += toAdd.length;
      out.removed += toRemove.length;
    }
    if (remoteId && w.overview !== undefined) {
      try {
        await client.setCollectionOverview(remoteId, w.overview);
      } catch {
        // The overview is a nicety; the collection itself is in sync.
      }
    }
    const now = this.now().toISOString();
    const values = { name: w.name, remoteId, itemCount: want.length, missing, lastSyncAt: now, lastError: null };
    row = this.row(w.key, serverId);
    if (row) this.db.update(collectionSyncs).set(values).where(eq(collectionSyncs.id, row.id)).run();
    else this.db.insert(collectionSyncs).values({ collectionKey: w.key, serverId, ...values }).run();
    return out;
  }

  /** Sync rows of every collection (admin overview). */
  syncStates(): (CollectionSyncState & { collectionKey: string })[] {
    const rows = this.db.select().from(collectionSyncs).all();
    return this.syncViews(rows).map((v, i) => ({ ...v, collectionKey: rows[i]!.collectionKey }));
  }
}
