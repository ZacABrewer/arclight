import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { MediaServerError, type MediaServerItem } from '@arclight/media-servers';
import { MediaServerTagSync, type MediaServerConfig, type MediaServerConnectionKind, type TagSyncChange, type TagSyncPreview, type TagSyncStatus } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { movies, series, tags } from '../../db/schema.js';
import { buildRemoteIndex, remoteIdFor, type RemoteIndexKind } from '../media-servers/remote-index.js';
import { mediaServerTagLocks, mediaServerTagSyncs, mediaServerTagSyncState, type MediaServerTagSyncRow } from './schema.js';

// Arclight's own tags (manual and tag-rule) copied onto the matching movies and series of a
// Jellyfin/Emby server (item Tags) or a Plex server (labels), as `prefix + tag label`.
//
// Ownership: every label Arclight writes gets a row in media_server_tag_syncs. A label is only
// ever removed from an item when a row says Arclight put it there; a label the item already had
// (a user set it on the server) is recorded as `preexisting` and never removed. A run compares
// the wanted labels with the owned rows, so items that are in sync cost no requests; only items
// that differ have their current tags read (in batches of 50) and written (one at a time, at
// most 4 requests a second per server).
//
// Triggers: library/tag events (debounced), the nightly job and Sync now. Runs are single-flight
// per server; ids that arrive during a run are taken on the next pass. Passes that run back to
// back (Sync now pressed while a pass is running) report their changes together, so a follow-up
// pass that finds nothing left to do does not overwrite the count with 0.
//
// Locks: with "Lock tags" on, a Jellyfin/Emby write puts `Tags` into the item's LockedFields.
// When that write is what locked it (it was not locked before), the item gets a row in
// media_server_tag_locks; turning sync off with Remove takes the lock off those items only. A
// lock a user set is never touched. Plex labels keep their lock (Plex's write does not say
// whether the field was locked before).

export type TagSyncKind = 'jellyfin' | 'emby' | 'plex';

/** Kinds whose items carry tags (Jellyfin/Emby Tags, Plex labels). */
export function isTagSyncKind(kind: MediaServerConnectionKind): kind is TagSyncKind {
  return kind === 'jellyfin' || kind === 'emby' || kind === 'plex';
}

/** A movie or series on the server, as far as a write needs it. */
export interface RemoteRef {
  id: string;
  mediaType: RemoteIndexKind;
  /** Plex section key (needed for the label write). */
  libraryId: string | null;
}

/** What the tag sync needs from one server; built from the media-server client. */
export interface TagSyncTarget {
  listItems(kind: RemoteIndexKind): Promise<MediaServerItem[]>;
  /** Current tags of items, by remote id (items gone from the server are left out). */
  readTags(ids: readonly string[]): Promise<Map<string, string[]>>;
  /**
   * `lock`: lock the tags against metadata refreshes. `unlock`: take that lock off (Remove, on
   * items Arclight locked). Resolves `lockAdded: true` when this write is what locked them.
   */
  writeTags(item: RemoteRef, add: readonly string[], remove: readonly string[], opts: TagWriteOptions): Promise<TagWriteResult | void>;
  /** HTTP requests one write takes (read-modify-write = 2), for the rate limit. */
  readonly requestsPerWrite: number;
}

export interface TagWriteOptions {
  lock: boolean;
  unlock?: boolean;
}

export interface TagWriteResult {
  /** The write put the tag lock on (it was not locked before). */
  lockAdded?: boolean;
}

export type TagSyncErrorCode = 'NOT_FOUND' | 'VALIDATION';

export class TagSyncError extends Error {
  constructor(
    readonly code: TagSyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TagSyncError';
  }
}

export interface EntityKey {
  type: RemoteIndexKind;
  id: number;
}

export interface TagSyncServiceOptions {
  db: Db;
  /** Every stored media-server connection. */
  servers: () => MediaServerConfig[];
  target: (config: MediaServerConfig) => TagSyncTarget;
  log?: Pick<Logger, 'info' | 'warn'>;
  /** Unix ms. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Requests per second per server. Default 4 (D21). */
  ratePerSecond?: number;
  /** Wait after a 429/503 before the one retry. Default 30 s. */
  backoffMs?: number;
  /** Quiet time before change-driven dirty ids are synced. Default 30 s (D20). */
  debounceMs?: number;
  /** Longest a change waits while changes keep coming. Default 5 min (D20). */
  maxWaitMs?: number;
}

export interface ReconcileOptions {
  /** Compute (and read), never write. */
  dryRun?: boolean;
  /** Remove every owned label (sync off, Remove), then forget the rows. */
  removeAll?: boolean;
  /** Items changed by earlier passes of the same run, added to the recorded count. */
  carriedChanged?: number;
}

export interface ReconcileResult {
  changes: TagSyncChange[];
  totalChanges: number;
  /** Titles with labels to write that the server does not have. */
  unmatched: number;
  /** Items written. */
  changed: number;
  errors: string[];
  /** Stopped after too many consecutive errors. */
  stopped: boolean;
}

/** Changes listed in a preview. */
export const PREVIEW_LIMIT = 500;
/** A run stops after this many failed writes in a row. */
export const MAX_CONSECUTIVE_ERRORS = 5;
const READ_BATCH = 50;

const lower = (v: string) => v.trim().toLowerCase();
const keyOf = (k: EntityKey) => `${k.type}:${k.id}`;

/** The stored settings with defaults filled (absent = off). */
export function tagSyncSettings(config: Pick<MediaServerConfig, 'tagSync'>): MediaServerTagSync {
  return MediaServerTagSync.parse(config.tagSync ?? {});
}

/**
 * The labels a title should carry on a server: its tags (all, or only the selected ones) as
 * `prefix + label`, without case-insensitive duplicates. None while sync is off.
 */
export function wantedLabels(tagIds: readonly number[], labels: ReadonlyMap<number, string>, settings: MediaServerTagSync): string[] {
  if (!settings.enabled) return [];
  const selected = settings.mode === 'selected' ? new Set(settings.tagIds) : null;
  const out = new Map<string, string>();
  for (const id of tagIds) {
    if (selected && !selected.has(id)) continue;
    const label = labels.get(id);
    if (!label) continue;
    const text = `${settings.prefix}${label}`.trim();
    if (!out.has(lower(text))) out.set(lower(text), text);
  }
  return [...out.values()];
}

/**
 * At most `ratePerSecond` tokens a second, evenly spaced (no bursts): each `take` reserves the
 * next free slot before it waits, so concurrent callers queue in order.
 */
export class TokenBucket {
  private nextAt = 0;
  constructor(
    private readonly ratePerSecond: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async take(n = 1): Promise<void> {
    const step = 1000 / this.ratePerSecond;
    const t = this.now();
    const at = Math.max(t, this.nextAt);
    this.nextAt = at + step * n;
    // The last of the n tokens is the one to wait for.
    const wait = at + step * (n - 1) - t;
    if (wait > 0) await this.sleep(wait);
  }
}

/** A library title as the sync sees it. */
interface Entity extends EntityKey {
  title: string;
  tmdbId: number;
  tvdbId: number | null;
  imdbId: string | null;
  tags: number[];
}

/** One remote item's work in a run. */
interface Plan {
  remoteId: string;
  entity: EntityKey;
  title: string;
  wanted: Map<string, string>;
  owned: MediaServerTagSyncRow[];
}

interface Queue {
  pending: Set<string> | 'all' | null;
  removeAll: boolean;
  running: Promise<void> | null;
}

export class TagSyncService {
  private readonly db: Db;
  private readonly opts: TagSyncServiceOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly queues = new Map<string, Queue>();
  private dirty = new Set<string>();
  private dirtyAll = false;
  /** Servers whose settings were saved with sync on: each gets a full pass at the next flush. */
  private dirtyServers = new Set<string>();
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: TagSyncServiceOptions) {
    this.db = opts.db;
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // ---- status --------------------------------------------------------------------------

  status(serverId: string): TagSyncStatus {
    this.server(serverId);
    const row = this.db.select().from(mediaServerTagSyncState).where(eq(mediaServerTagSyncState.serverId, serverId)).get();
    return {
      running: this.queues.get(serverId)?.running != null,
      lastRunAt: row?.lastRunAt ?? null,
      lastChanged: row?.lastChanged ?? 0,
      lastUnmatched: row?.lastUnmatched ?? 0,
      lastError: row?.lastError ?? null,
    };
  }

  /** Ownership rows of a server (tests and the admin view). */
  owned(serverId: string): MediaServerTagSyncRow[] {
    return this.db.select().from(mediaServerTagSyncs).where(eq(mediaServerTagSyncs.serverId, serverId)).all();
  }

  /** Items whose tag lock Arclight added (tests and the admin view). */
  locks(serverId: string): string[] {
    return this.db
      .select({ id: mediaServerTagLocks.remoteItemId })
      .from(mediaServerTagLocks)
      .where(eq(mediaServerTagLocks.serverId, serverId))
      .all()
      .map((r) => r.id);
  }

  /** Keep: forget what Arclight added (the labels and their locks stay on the server, unowned). */
  forget(serverId: string): number {
    this.server(serverId);
    this.db.delete(mediaServerTagLocks).where(eq(mediaServerTagLocks.serverId, serverId)).run();
    return this.db.delete(mediaServerTagSyncs).where(eq(mediaServerTagSyncs.serverId, serverId)).run().changes;
  }

  /** Rows and state of servers that no longer exist. */
  prune(): void {
    const ids = this.opts.servers().map((s) => s.id);
    if (ids.length === 0) {
      this.db.delete(mediaServerTagSyncs).run();
      this.db.delete(mediaServerTagLocks).run();
      this.db.delete(mediaServerTagSyncState).run();
      return;
    }
    this.db.delete(mediaServerTagSyncs).where(notInArray(mediaServerTagSyncs.serverId, ids)).run();
    this.db.delete(mediaServerTagLocks).where(notInArray(mediaServerTagLocks.serverId, ids)).run();
    this.db.delete(mediaServerTagSyncState).where(notInArray(mediaServerTagSyncState.serverId, ids)).run();
  }

  // ---- runs ----------------------------------------------------------------------------

  /** A full dry run: what Sync now would change. */
  async preview(serverId: string): Promise<TagSyncPreview> {
    const r = await this.reconcile(serverId, 'all', { dryRun: true });
    return { changes: r.changes.slice(0, PREVIEW_LIMIT), totalChanges: r.totalChanges, unmatched: r.unmatched, truncated: r.totalChanges > PREVIEW_LIMIT };
  }

  /** Queues a pass (single-flight per server); resolves once the pass that includes it is done. */
  schedule(serverId: string, scope: readonly EntityKey[] | 'all'): Promise<void> {
    const q = this.queue(serverId);
    // Nothing new: wait for the pass in flight, if any.
    if (scope !== 'all' && scope.length === 0 && !q.removeAll) return q.running ?? Promise.resolve();
    if (scope === 'all') q.pending = 'all';
    else if (q.pending !== 'all') {
      q.pending ??= new Set();
      for (const k of scope) q.pending.add(keyOf(k));
    }
    q.running ??= this.drain(serverId, q);
    return q.running;
  }

  /** Sync now / nightly: a full reconcile. */
  runNow(serverId: string): Promise<void> {
    this.writable(serverId);
    return this.schedule(serverId, 'all');
  }

  /** Remove: take every owned label off the server, then forget the rows. */
  removeAll(serverId: string): Promise<void> {
    this.writable(serverId);
    this.queue(serverId).removeAll = true;
    return this.schedule(serverId, 'all');
  }

  /** The nightly job: a full reconcile of every server that syncs tags or still owns some. */
  async runAll(): Promise<{ servers: number; changed: number; errors: string[] }> {
    this.prune();
    const out = { servers: 0, changed: 0, errors: [] as string[] };
    for (const config of this.candidates()) {
      out.servers++;
      await this.schedule(config.id, 'all');
      const st = this.status(config.id);
      out.changed += st.lastChanged;
      if (st.lastError) out.errors.push(`${config.name}: ${st.lastError}`);
    }
    return out;
  }

  private queue(serverId: string): Queue {
    let q = this.queues.get(serverId);
    if (!q) {
      q = { pending: null, removeAll: false, running: null };
      this.queues.set(serverId, q);
    }
    return q;
  }

  private async drain(serverId: string, q: Queue): Promise<void> {
    try {
      // A microtask first, so `running` is set before the first pass can finish.
      await Promise.resolve();
      // Changes of the passes so far: a follow-up pass adds to them instead of replacing them.
      let changed = 0;
      while (q.pending) {
        const scope = q.pending;
        q.pending = null;
        const removeAll = q.removeAll;
        q.removeAll = false;
        try {
          const keys = scope === 'all' ? 'all' : [...scope].map(parseKey);
          changed += (await this.reconcile(serverId, keys, { removeAll, carriedChanged: changed })).changed;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.opts.log?.warn({ err, serverId }, 'tag sync failed');
          if (this.serverOrNull(serverId)) this.recordState(serverId, { lastError: message });
        }
      }
    } finally {
      q.running = null;
    }
  }

  /**
   * Brings the owned labels of `scope` in line with the wanted ones (see the file comment).
   * Dry runs read but never write and leave the rows alone.
   */
  async reconcile(serverId: string, scope: readonly EntityKey[] | 'all', opts: ReconcileOptions = {}): Promise<ReconcileResult> {
    const config = this.writable(serverId);
    const settings = tagSyncSettings(config);
    const active = settings.enabled && !opts.removeAll;
    const dryRun = opts.dryRun === true;
    const result: ReconcileResult = { changes: [], totalChanges: 0, unmatched: 0, changed: 0, errors: [], stopped: false };

    const rows = this.rowsFor(serverId, scope);
    // Remove takes off the tag locks Arclight added (a dry run never writes, so it skips them).
    const locked = opts.removeAll && !dryRun ? new Set(this.locks(serverId)) : new Set<string>();
    const entities = active ? this.entities(scope) : this.entities(rows.map((r) => ({ type: r.entityType, id: r.entityId })));
    const labels = new Map(this.db.select().from(tags).all().map((t) => [t.id, t.label]));
    const wantedOf = new Map<string, string[]>();
    for (const e of entities.values()) {
      const wanted = active ? wantedLabels(e.tags, labels, settings) : [];
      if (wanted.length) wantedOf.set(keyOf(e), wanted);
    }
    if (wantedOf.size === 0 && rows.length === 0 && locked.size === 0) {
      if (!dryRun) this.finish(serverId, scope, result, opts.carriedChanged ?? 0);
      return result;
    }

    const target = this.opts.target(config);
    const kinds = new Set<RemoteIndexKind>([...wantedOf.keys()].map((k) => parseKey(k).type));
    for (const r of rows) kinds.add(r.entityType);
    // One listing per kind serves both the id index and the Plex section keys.
    const listed = new Map<RemoteIndexKind, MediaServerItem[]>();
    for (const kind of kinds) listed.set(kind, await target.listItems(kind));
    const index = await buildRemoteIndex({ listItems: async (kind) => listed.get(kind as RemoteIndexKind) ?? [] }, kinds);
    const items = new Map<string, MediaServerItem>();
    for (const list of listed.values()) for (const item of list) items.set(item.id, item);

    // One plan per remote item: what it should carry and what Arclight owns on it.
    const plans = new Map<string, Plan>();
    const planOf = (remoteId: string, entity: EntityKey): Plan => {
      let p = plans.get(remoteId);
      if (!p) {
        p = { remoteId, entity: { type: entity.type, id: entity.id }, title: entities.get(keyOf(entity))?.title ?? `${entity.type} ${entity.id}`, wanted: new Map(), owned: [] };
        plans.set(remoteId, p);
      }
      return p;
    };
    for (const [key, wanted] of wantedOf) {
      const e = entities.get(key)!;
      const remoteId = remoteIdFor(index, e.type, e);
      if (!remoteId) {
        result.unmatched++;
        continue;
      }
      const p = planOf(remoteId, e);
      for (const label of wanted) p.wanted.set(lower(label), label);
    }
    for (const r of rows) planOf(r.remoteItemId, { type: r.entityType, id: r.entityId }).owned.push(r);
    // A locked item with no owned labels left still needs its lock taken off.
    const unplanned = [...locked].filter((id) => !plans.has(id));

    // Items whose wanted set differs from the owned set.
    const work: { plan: Plan; add: string[]; remove: MediaServerTagSyncRow[]; forget: MediaServerTagSyncRow[] }[] = [];
    for (const plan of plans.values()) {
      const owned = new Set(plan.owned.map((r) => lower(r.label)));
      const add = [...plan.wanted].filter(([k]) => !owned.has(k)).map(([, label]) => label);
      const unwanted = plan.owned.filter((r) => !plan.wanted.has(lower(r.label)));
      const remove = unwanted.filter((r) => !r.preexisting);
      const forget = unwanted.filter((r) => r.preexisting);
      if (add.length || remove.length || forget.length || locked.has(plan.remoteId)) work.push({ plan, add, remove, forget });
    }

    // Current tags of the items that may need a write.
    const needsWrite = (w: { plan: Plan; add: string[]; remove: MediaServerTagSyncRow[] }) => w.add.length > 0 || w.remove.length > 0 || locked.has(w.plan.remoteId);
    const toRead = [...work.filter(needsWrite).map((w) => w.plan.remoteId), ...unplanned];
    const current = new Map<string, string[]>();
    const bucket = this.bucket(serverId);
    for (let i = 0; i < toRead.length; i += READ_BATCH) {
      const batch = toRead.slice(i, i + READ_BATCH);
      for (const [id, list] of await this.withRetry(bucket, 1, () => target.readTags(batch))) current.set(id, list);
    }

    let consecutive = 0;
    for (const w of work) {
      const { plan } = w;
      const at = this.now();
      if (!needsWrite(w)) {
        if (!dryRun) this.deleteRows(w.forget);
        continue;
      }
      const have = current.get(plan.remoteId);
      if (have === undefined) {
        // Gone from the server: nothing to remove, nothing to add to.
        if (!dryRun) {
          this.deleteRows([...w.remove, ...w.forget]);
          this.deleteLock(serverId, plan.remoteId);
        }
        continue;
      }
      const present = new Set(have.map(lower));
      const already = w.add.filter((l) => present.has(lower(l)));
      const add = w.add.filter((l) => !present.has(lower(l)));
      const remove = w.remove.filter((r) => present.has(lower(r.label)));
      if (add.length || remove.length) {
        result.totalChanges++;
        if (result.changes.length < PREVIEW_LIMIT) {
          result.changes.push({ entityType: plan.entity.type, entityId: plan.entity.id, title: plan.title, remoteItemId: plan.remoteId, add, remove: remove.map((r) => r.label) });
        }
      }
      if (dryRun || result.stopped) continue;
      const unlock = locked.has(plan.remoteId);
      if (add.length || remove.length || unlock) {
        const item = items.get(plan.remoteId);
        const ref: RemoteRef = { id: plan.remoteId, mediaType: item?.mediaType === 'series' ? 'series' : item?.mediaType === 'movie' ? 'movie' : plan.entity.type, libraryId: item?.libraryId ?? null };
        try {
          const written = await this.withRetry(bucket, target.requestsPerWrite, () =>
            target.writeTags(
              ref,
              add,
              remove.map((r) => r.label),
              // Remove adds nothing, so it never locks; it unlocks only the items Arclight locked.
              opts.removeAll ? { lock: false, ...(unlock ? { unlock: true } : {}) } : { lock: settings.lockTags },
            ),
          );
          consecutive = 0;
          result.changed++;
          if (unlock) this.deleteLock(serverId, plan.remoteId);
          else if (written?.lockAdded) this.insertLock(serverId, plan.remoteId, at);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(`${plan.title}: ${message}`);
          if (++consecutive >= MAX_CONSECUTIVE_ERRORS) result.stopped = true;
          continue;
        }
      }
      this.insertRows(serverId, plan, add, false, at);
      this.insertRows(serverId, plan, already, true, at);
      this.deleteRows([...w.remove, ...w.forget]);
    }

    // Locked items Arclight owns no labels on any more: only the lock to take off.
    for (const remoteId of unplanned) {
      if (result.stopped) break;
      if (!current.has(remoteId)) {
        this.deleteLock(serverId, remoteId);
        continue;
      }
      const item = items.get(remoteId);
      const ref: RemoteRef = { id: remoteId, mediaType: item?.mediaType === 'series' ? 'series' : 'movie', libraryId: item?.libraryId ?? null };
      try {
        await this.withRetry(bucket, target.requestsPerWrite, () => target.writeTags(ref, [], [], { lock: false, unlock: true }));
        consecutive = 0;
        result.changed++;
        this.deleteLock(serverId, remoteId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${item?.title ?? remoteId}: ${message}`);
        if (++consecutive >= MAX_CONSECUTIVE_ERRORS) result.stopped = true;
      }
    }

    if (!dryRun) {
      if (opts.removeAll && result.errors.length === 0) this.forget(serverId);
      this.finish(serverId, scope, result, opts.carriedChanged ?? 0);
      if (result.changed || result.errors.length) {
        this.opts.log?.info({ serverId, changed: result.changed, errors: result.errors.length, unmatched: result.unmatched }, 'tag sync ran');
      }
    }
    return result;
  }

  // ---- change-driven -------------------------------------------------------------------

  /** A title's tags may have changed: sync it after 30 s of quiet (at most 5 min). */
  markDirty(key: EntityKey | 'all'): void {
    if (key === 'all') this.dirtyAll = true;
    else this.dirty.add(keyOf(key));
    this.arm();
  }

  /**
   * Media server settings were saved: every enabled server with sync on gets a full pass on the
   * same debounce, so a new filter, prefix or newly turned-on sync applies about 30 s later.
   */
  markSyncingServersDirty(): void {
    const syncing = this.opts.servers().filter((c) => c.enabled && isTagSyncKind(c.kind) && tagSyncSettings(c).enabled);
    if (syncing.length === 0) return;
    for (const c of syncing) this.dirtyServers.add(c.id);
    this.arm();
  }

  private arm(): void {
    const fire = () => void this.flush().catch((err: unknown) => this.opts.log?.warn({ err }, 'tag sync flush failed'));
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(fire, this.opts.debounceMs ?? 30_000);
    this.quietTimer.unref?.();
    if (!this.maxTimer) {
      this.maxTimer = setTimeout(fire, this.opts.maxWaitMs ?? 300_000);
      this.maxTimer.unref?.();
    }
  }

  /** Syncs the dirty titles on every server that syncs tags (or still owns some), and saved servers in full. */
  async flush(): Promise<void> {
    this.clearTimers();
    const all = this.dirtyAll;
    const keys = [...this.dirty].map(parseKey);
    const servers = this.dirtyServers;
    this.dirty = new Set();
    this.dirtyAll = false;
    this.dirtyServers = new Set();
    if (!all && keys.length === 0 && servers.size === 0) return;
    await Promise.all(
      this.candidates()
        .filter((c) => all || keys.length > 0 || servers.has(c.id))
        .map((c) => this.schedule(c.id, all || servers.has(c.id) ? 'all' : keys)),
    );
  }

  dispose(): void {
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.quietTimer = null;
    this.maxTimer = null;
  }

  // ---- helpers -------------------------------------------------------------------------

  /** Enabled tag-sync servers with sync on or owned rows left. */
  private candidates(): MediaServerConfig[] {
    return this.opts.servers().filter((c) => {
      if (!c.enabled || !isTagSyncKind(c.kind)) return false;
      if (tagSyncSettings(c).enabled) return true;
      return this.db.select({ id: mediaServerTagSyncs.serverId }).from(mediaServerTagSyncs).where(eq(mediaServerTagSyncs.serverId, c.id)).limit(1).get() !== undefined;
    });
  }

  private serverOrNull(id: string): MediaServerConfig | undefined {
    return this.opts.servers().find((s) => s.id === id);
  }

  private server(id: string): MediaServerConfig {
    const found = this.serverOrNull(id);
    if (!found) throw new TagSyncError('NOT_FOUND', `Media server ${id} not found`);
    return found;
  }

  /** A server tags can be written to: Jellyfin, Emby or Plex, and enabled. */
  private writable(id: string): MediaServerConfig {
    const config = this.server(id);
    if (!isTagSyncKind(config.kind)) throw new TagSyncError('VALIDATION', `${config.name} does not support tags`);
    if (!config.enabled) throw new TagSyncError('VALIDATION', `${config.name} is disabled`);
    return config;
  }

  private bucket(serverId: string): TokenBucket {
    let b = this.buckets.get(serverId);
    if (!b) {
      b = new TokenBucket(this.opts.ratePerSecond ?? 4, this.now, this.sleep);
      this.buckets.set(serverId, b);
    }
    return b;
  }

  /** Rate-limited call; a 429 or 503 waits 30 s and is retried once. */
  private async withRetry<T>(bucket: TokenBucket, tokens: number, fn: () => Promise<T>): Promise<T> {
    await bucket.take(tokens);
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof MediaServerError) || (err.code !== 'rateLimited' && err.status !== 429 && err.status !== 503)) throw err;
      await this.sleep(this.opts.backoffMs ?? 30_000);
      await bucket.take(tokens);
      return fn();
    }
  }

  private rowsFor(serverId: string, scope: readonly EntityKey[] | 'all'): MediaServerTagSyncRow[] {
    const all = this.owned(serverId);
    if (scope === 'all') return all;
    const keys = new Set(scope.map(keyOf));
    return all.filter((r) => keys.has(`${r.entityType}:${r.entityId}`));
  }

  /** Library titles by key: every movie and series, or the given ones (missing ones are left out). */
  private entities(scope: readonly EntityKey[] | 'all'): Map<string, Entity> {
    const out = new Map<string, Entity>();
    const want = (type: RemoteIndexKind) => (scope === 'all' ? null : [...new Set(scope.filter((k) => k.type === type).map((k) => k.id))]);
    const movieIds = want('movie');
    if (movieIds === null || movieIds.length) {
      const q = this.db.select({ id: movies.id, title: movies.title, tmdbId: movies.tmdbId, imdbId: movies.imdbId, tags: movies.tags }).from(movies);
      for (const m of movieIds === null ? q.all() : q.where(inArray(movies.id, movieIds)).all()) out.set(`movie:${m.id}`, { type: 'movie', ...m, tvdbId: null });
    }
    const seriesIds = want('series');
    if (seriesIds === null || seriesIds.length) {
      const q = this.db.select({ id: series.id, title: series.title, tmdbId: series.tmdbId, tvdbId: series.tvdbId, imdbId: series.imdbId, tags: series.tags }).from(series);
      for (const s of seriesIds === null ? q.all() : q.where(inArray(series.id, seriesIds)).all()) out.set(`series:${s.id}`, { type: 'series', ...s });
    }
    return out;
  }

  private insertRows(serverId: string, plan: Plan, labels: readonly string[], preexisting: boolean, at: number): void {
    for (const label of labels) {
      this.db
        .insert(mediaServerTagSyncs)
        .values({ serverId, entityType: plan.entity.type, entityId: plan.entity.id, remoteItemId: plan.remoteId, label, preexisting, addedAt: at })
        .onConflictDoNothing()
        .run();
    }
  }

  private deleteRows(rows: readonly MediaServerTagSyncRow[]): void {
    for (const r of rows) {
      this.db
        .delete(mediaServerTagSyncs)
        .where(and(eq(mediaServerTagSyncs.serverId, r.serverId), eq(mediaServerTagSyncs.remoteItemId, r.remoteItemId), eq(mediaServerTagSyncs.label, r.label)))
        .run();
    }
  }

  private insertLock(serverId: string, remoteItemId: string, at: number): void {
    this.db.insert(mediaServerTagLocks).values({ serverId, remoteItemId, addedAt: at }).onConflictDoNothing().run();
  }

  private deleteLock(serverId: string, remoteItemId: string): void {
    this.db
      .delete(mediaServerTagLocks)
      .where(and(eq(mediaServerTagLocks.serverId, serverId), eq(mediaServerTagLocks.remoteItemId, remoteItemId)))
      .run();
  }

  /** `carried`: items changed by earlier passes of the same run (see `drain`). */
  private finish(serverId: string, scope: readonly EntityKey[] | 'all', r: ReconcileResult, carried = 0): void {
    const lastError = r.stopped ? `stopped after ${MAX_CONSECUTIVE_ERRORS} errors in a row: ${r.errors.at(-1) ?? ''}` : (r.errors.at(-1) ?? null);
    this.recordState(serverId, {
      lastRunAt: new Date(this.now()).toISOString(),
      lastChanged: carried + r.changed,
      // A pass over a few changed titles says nothing about the rest of the library.
      ...(scope === 'all' ? { lastUnmatched: r.unmatched } : {}),
      lastError,
    });
  }

  private recordState(serverId: string, values: Partial<Omit<typeof mediaServerTagSyncState.$inferInsert, 'serverId'>>): void {
    this.db
      .insert(mediaServerTagSyncState)
      .values({ serverId, ...values })
      .onConflictDoUpdate({ target: mediaServerTagSyncState.serverId, set: values })
      .run();
  }
}

function parseKey(key: string): EntityKey {
  const [type, id] = key.split(':');
  return { type: type === 'series' ? 'series' : 'movie', id: Number(id) };
}
