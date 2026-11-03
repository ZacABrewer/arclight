import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaServerTagSync, type MediaServerConfig } from '@arclight/shared';
import { MediaServerError, mergeTags, type MediaServerItem } from '@arclight/media-servers';
import { eq } from 'drizzle-orm';
import { openDatabase, type Db } from '../../db/index.js';
import { movies, series, tags } from '../../db/schema.js';
import { setup } from '../requests/test-support.js';
import { addMovie, addSeries } from '../watch-history/test-support.js';
import { MAX_CONSECUTIVE_ERRORS, TagSyncService, TokenBucket, wantedLabels, type RemoteRef, type TagSyncTarget } from './service.js';

/** An in-memory Jellyfin as far as item tags go. */
class FakeTarget implements TagSyncTarget {
  items: { movie: MediaServerItem[]; series: MediaServerItem[] } = { movie: [], series: [] };
  tags = new Map<string, string[]>();
  reads: string[][] = [];
  writes: { id: string; add: string[]; remove: string[]; lock: boolean }[] = [];
  lists = 0;
  /** Errors thrown by the next writes, in order. */
  failures: Error[] = [];
  requestsPerWrite = 2;

  async listItems(kind: 'movie' | 'series') {
    this.lists++;
    return this.items[kind];
  }
  async readTags(ids: readonly string[]) {
    this.reads.push([...ids]);
    return new Map(ids.filter((id) => this.tags.has(id)).map((id) => [id, [...this.tags.get(id)!]]));
  }
  async writeTags(item: RemoteRef, add: readonly string[], remove: readonly string[], opts: { lock: boolean }) {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.writes.push({ id: item.id, add: [...add], remove: [...remove], lock: opts.lock });
    this.tags.set(item.id, mergeTags(this.tags.get(item.id) ?? [], add, remove));
  }
}

const item = (id: string, mediaType: 'movie' | 'series', ids: Partial<MediaServerItem['ids']>): MediaServerItem => ({ id, mediaType, title: id, year: null, ids: { tmdbId: null, tvdbId: null, imdbId: null, ...ids }, path: null, libraryId: '1' });

async function harness(sync: Partial<MediaServerTagSync> = { enabled: true }) {
  const h = await setup();
  const db = h.db;
  const target = new FakeTarget();
  let config = { id: 'jf1', name: 'Den', kind: 'jellyfin', enabled: true, url: 'http://jellyfin.example.com', apiKey: 'k', tagSync: MediaServerTagSync.parse(sync) } as MediaServerConfig;
  const slept: number[] = [];
  let clock = 1_000_000;
  const svc = new TagSyncService({
    db,
    servers: () => [config],
    target: () => target,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  const tag = (label: string) => db.insert(tags).values({ label }).returning().get().id;
  const kids = tag('kids');
  const adult = tag('adult');
  const arrival = addMovie(db, 1, 'Arrival', { imdbId: 'tt0000001' });
  const heat = addMovie(db, 2, 'Heat');
  const lost = addMovie(db, 3, 'Not On Server');
  const harbour = addSeries(db, 50, 1050, 'Harbour Lights', [2]);
  target.items.movie = [item('m1', 'movie', { imdbId: 'tt0000001' }), item('m2', 'movie', { tmdbId: 2 })];
  target.items.series = [item('s1', 'series', { tvdbId: 1050 })];
  target.tags.set('m1', ['Favourite']);
  target.tags.set('m2', []);
  target.tags.set('s1', []);
  const setTags = (table: 'movie' | 'series', id: number, ids: number[]) =>
    table === 'movie' ? db.update(movies).set({ tags: ids }).where(eq(movies.id, id)).run() : db.update(series).set({ tags: ids }).where(eq(series.id, id)).run();
  return {
    db,
    svc,
    target,
    slept,
    ids: { kids, adult, arrival, heat, lost, harbour },
    setTags,
    setSync: (next: Partial<MediaServerTagSync>) => {
      config = { ...config, tagSync: MediaServerTagSync.parse({ ...config.tagSync, ...next }) };
    },
    setConfig: (next: Partial<MediaServerConfig>) => {
      config = { ...config, ...next };
    },
  };
}

describe('wantedLabels', () => {
  const labels = new Map([
    [1, 'kids'],
    [2, 'adult'],
    [3, 'Kids'],
  ]);
  it('writes every tag with the prefix, without case-insensitive duplicates', () => {
    expect(wantedLabels([1, 2, 3, 9], labels, MediaServerTagSync.parse({ enabled: true, prefix: 'arclight:' }))).toEqual(['arclight:kids', 'arclight:adult']);
  });
  it('keeps only the selected tags in Selected mode', () => {
    expect(wantedLabels([1, 2], labels, MediaServerTagSync.parse({ enabled: true, mode: 'selected', tagIds: [2] }))).toEqual(['adult']);
  });
  it('wants nothing while off', () => {
    expect(wantedLabels([1, 2], labels, MediaServerTagSync.parse({}))).toEqual([]);
  });
});

describe('TokenBucket', () => {
  it('spaces tokens evenly at the rate', async () => {
    let t = 0;
    const waits: number[] = [];
    const bucket = new TokenBucket(4, () => t, async (ms) => {
      waits.push(ms);
      t += ms;
    });
    await bucket.take();
    await bucket.take();
    await bucket.take(2);
    // 0, 250 ms later, then two tokens ending 500 ms after that.
    expect(waits).toEqual([250, 500]);
    expect(t).toBe(750);
  });
});

describe('TagSyncService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds the wanted labels, keeps user tags, and touches only items that differ', async () => {
    const t = await harness({ enabled: true, prefix: 'arclight:' });
    t.setTags('movie', t.ids.arrival, [t.ids.kids]);
    t.setTags('series', t.ids.harbour, [t.ids.kids, t.ids.adult]);
    const r = await t.svc.reconcile('jf1', 'all');
    expect(r.changed).toBe(2);
    expect(t.target.tags.get('m1')).toEqual(['Favourite', 'arclight:kids']);
    expect(t.target.tags.get('s1')).toEqual(['arclight:kids', 'arclight:adult']);
    expect(t.target.writes.every((w) => w.lock)).toBe(true);
    expect(t.svc.owned('jf1')).toHaveLength(3);
    expect(t.svc.status('jf1')).toMatchObject({ lastChanged: 2, lastError: null, running: false });

    // In sync: no reads, no writes.
    t.target.reads = [];
    t.target.writes = [];
    expect((await t.svc.reconcile('jf1', 'all')).changed).toBe(0);
    expect(t.target.reads).toEqual([]);
    expect(t.target.writes).toEqual([]);
  });

  it('never removes a tag the item already had, nor tags users added', async () => {
    const t = await harness({ enabled: true });
    t.target.tags.set('m1', ['Kids', 'Favourite']);
    t.setTags('movie', t.ids.arrival, [t.ids.kids]);
    await t.svc.reconcile('jf1', 'all');
    // Already there: recorded as preexisting, nothing written.
    expect(t.target.writes).toEqual([]);
    expect(t.svc.owned('jf1')).toMatchObject([{ remoteItemId: 'm1', label: 'kids', preexisting: true }]);

    t.setTags('movie', t.ids.arrival, []);
    await t.svc.reconcile('jf1', 'all');
    expect(t.target.writes).toEqual([]);
    expect(t.target.tags.get('m1')).toEqual(['Kids', 'Favourite']);
    expect(t.svc.owned('jf1')).toEqual([]);
  });

  it('removes owned labels when a tag leaves the item, the selection or is renamed', async () => {
    const t = await harness({ enabled: true });
    t.setTags('movie', t.ids.heat, [t.ids.kids, t.ids.adult]);
    await t.svc.reconcile('jf1', 'all');
    expect(t.target.tags.get('m2')).toEqual(['kids', 'adult']);

    t.setSync({ mode: 'selected', tagIds: [t.ids.kids] });
    await t.svc.reconcile('jf1', [{ type: 'movie', id: t.ids.heat }]);
    expect(t.target.tags.get('m2')).toEqual(['kids']);

    t.db.update(tags).set({ label: 'family' }).where(eq(tags.id, t.ids.kids)).run();
    await t.svc.reconcile('jf1', 'all');
    expect(t.target.writes.at(-1)).toMatchObject({ id: 'm2', add: ['family'], remove: ['kids'] });
    expect(t.target.tags.get('m2')).toEqual(['family']);
    expect(t.svc.owned('jf1').map((r) => r.label)).toEqual(['family']);
  });

  it('removes what it added when the item lost the tag on the server already', async () => {
    const t = await harness({ enabled: true });
    t.setTags('movie', t.ids.heat, [t.ids.kids]);
    await t.svc.reconcile('jf1', 'all');
    t.target.tags.set('m2', []);
    t.setTags('movie', t.ids.heat, []);
    t.target.writes = [];
    await t.svc.reconcile('jf1', 'all');
    expect(t.target.writes).toEqual([]);
    expect(t.svc.owned('jf1')).toEqual([]);
  });

  it('counts titles that are not on the server', async () => {
    const t = await harness({ enabled: true });
    t.setTags('movie', t.ids.lost, [t.ids.kids]);
    t.setTags('movie', t.ids.heat, [t.ids.kids]);
    const r = await t.svc.reconcile('jf1', 'all');
    expect(r.unmatched).toBe(1);
    expect(t.svc.status('jf1').lastUnmatched).toBe(1);
  });

  it('previews without writing or recording anything', async () => {
    const t = await harness({ enabled: true, prefix: 'arclight:' });
    t.setTags('movie', t.ids.arrival, [t.ids.kids]);
    t.setTags('movie', t.ids.lost, [t.ids.kids]);
    const p = await t.svc.preview('jf1');
    expect(p).toEqual({
      changes: [{ entityType: 'movie', entityId: t.ids.arrival, title: 'Arrival', remoteItemId: 'm1', add: ['arclight:kids'], remove: [] }],
      totalChanges: 1,
      unmatched: 1,
      truncated: false,
    });
    expect(t.target.writes).toEqual([]);
    expect(t.svc.owned('jf1')).toEqual([]);
    expect(t.svc.status('jf1').lastRunAt).toBeNull();
  });

  it('turning sync off: remove-all takes the labels off; forget keeps them', async () => {
    const t = await harness({ enabled: true });
    t.setTags('movie', t.ids.arrival, [t.ids.kids]);
    t.setTags('movie', t.ids.heat, [t.ids.adult]);
    await t.svc.reconcile('jf1', 'all');
    t.setSync({ enabled: false });

    // Remove: every owned label comes off, user tags stay.
    await t.svc.removeAll('jf1');
    expect(t.target.tags.get('m1')).toEqual(['Favourite']);
    expect(t.target.tags.get('m2')).toEqual([]);
    expect(t.svc.owned('jf1')).toEqual([]);

    t.setSync({ enabled: true });
    await t.svc.reconcile('jf1', 'all');
    t.setSync({ enabled: false });
    expect(t.svc.forget('jf1')).toBe(2);
    t.target.writes = [];
    await t.svc.runNow('jf1');
    expect(t.target.writes).toEqual([]);
    expect(t.target.tags.get('m1')).toEqual(['Favourite', 'kids']);
  });

  it('removes owned labels on the next run when sync is off, without listing a server it owns nothing on', async () => {
    const t = await harness({ enabled: true });
    t.setTags('movie', t.ids.heat, [t.ids.kids]);
    await t.svc.reconcile('jf1', 'all');
    t.setSync({ enabled: false });
    await t.svc.reconcile('jf1', 'all');
    expect(t.target.tags.get('m2')).toEqual([]);
    const lists = t.target.lists;
    await t.svc.reconcile('jf1', 'all');
    expect(t.target.lists).toBe(lists);
  });

  it('retries once after a 429, and stops after 5 errors in a row', async () => {
    const t = await harness({ enabled: true });
    t.setTags('movie', t.ids.arrival, [t.ids.kids]);
    t.target.failures = [new MediaServerError('jellyfin', 'rateLimited', 'slow down', { status: 429 })];
    expect((await t.svc.reconcile('jf1', 'all')).changed).toBe(1);
    expect(t.slept).toContain(30_000);

    // Seven titles that need a write, every write failing.
    for (let i = 0; i < 7; i++) {
      const id = addMovie(t.db, 100 + i, `Extra ${i}`);
      t.setTags('movie', id, [t.ids.adult]);
      t.target.items.movie.push(item(`x${i}`, 'movie', { tmdbId: 100 + i }));
      t.target.tags.set(`x${i}`, []);
    }
    t.target.failures = Array.from({ length: 10 }, () => new Error('boom'));
    const r = await t.svc.reconcile('jf1', 'all');
    expect(r.stopped).toBe(true);
    expect(r.errors).toHaveLength(MAX_CONSECUTIVE_ERRORS);
    expect(t.target.failures).toHaveLength(10 - MAX_CONSECUTIVE_ERRORS);
    expect(t.svc.status('jf1').lastError).toMatch(/stopped after 5 errors/);
  });

  it('reads current tags in batches of 50, rate limited', async () => {
    const t = await harness({ enabled: true });
    for (let i = 0; i < 60; i++) {
      const id = addMovie(t.db, 200 + i, `Bulk ${i}`);
      t.setTags('movie', id, [t.ids.kids]);
      t.target.items.movie.push(item(`b${i}`, 'movie', { tmdbId: 200 + i }));
      t.target.tags.set(`b${i}`, []);
    }
    await t.svc.reconcile('jf1', 'all');
    expect(t.target.reads.map((r) => r.length)).toEqual([50, 10]);
    expect(t.target.writes).toHaveLength(60);
    // 2 reads + 60 writes x 2 requests at 4 a second: about 30 s of spacing.
    const waited = t.slept.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(30_000);
    expect(waited).toBeLessThan(31_000);
  });

  it('flushes dirty titles after 30 s of quiet, or 5 minutes at most', async () => {
    vi.useFakeTimers();
    const t = await harness({ enabled: true });
    const runs: unknown[] = [];
    const schedule = t.svc.schedule.bind(t.svc);
    t.svc.schedule = (id, scope) => {
      runs.push(scope);
      return schedule(id, scope);
    };
    t.svc.markDirty({ type: 'movie', id: t.ids.heat });
    await vi.advanceTimersByTimeAsync(20_000);
    t.svc.markDirty({ type: 'movie', id: t.ids.arrival });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toEqual([[{ type: 'movie', id: t.ids.heat }, { type: 'movie', id: t.ids.arrival }]]);

    // Changes every 20 s never go quiet: the 5-minute cap flushes them.
    runs.length = 0;
    for (let i = 0; i < 16; i++) {
      t.svc.markDirty('all');
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(runs).toEqual(['all']);
    t.svc.dispose();
  });

  it('gives every syncing server a full pass 30 s after server settings are saved', async () => {
    vi.useFakeTimers();
    const t = await harness({ enabled: true });
    const runs: [string, unknown][] = [];
    const schedule = t.svc.schedule.bind(t.svc);
    t.svc.schedule = (id, scope) => {
      runs.push([id, scope]);
      return schedule(id, scope);
    };
    t.svc.markSyncingServersDirty();
    t.svc.markDirty({ type: 'movie', id: t.ids.heat });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toEqual([['jf1', 'all']]);

    // With sync off nothing is queued (owned labels wait for the next change or Remove all).
    runs.length = 0;
    t.setSync({ enabled: false });
    t.svc.markSyncingServersDirty();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runs).toEqual([]);
    t.svc.dispose();
  });

  it('runs one pass at a time per server, folding ids that arrive meanwhile into the next', async () => {
    const t = await harness({ enabled: true });
    t.setTags('movie', t.ids.arrival, [t.ids.kids]);
    t.setTags('movie', t.ids.heat, [t.ids.kids]);
    const spy = vi.spyOn(t.svc, 'reconcile');
    const a = t.svc.schedule('jf1', [{ type: 'movie', id: t.ids.arrival }]);
    const b = t.svc.schedule('jf1', [{ type: 'movie', id: t.ids.heat }]);
    expect(t.svc.status('jf1').running).toBe(true);
    await Promise.all([a, b]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(t.target.writes.map((w) => w.id).sort()).toEqual(['m1', 'm2']);
    expect(t.svc.status('jf1').running).toBe(false);
  });

  it('refuses disabled servers and servers without tags, and prunes rows of deleted servers', async () => {
    const t = await harness({ enabled: true });
    t.setTags('movie', t.ids.heat, [t.ids.kids]);
    await t.svc.reconcile('jf1', 'all');
    t.setConfig({ enabled: false });
    await expect(t.svc.preview('jf1')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await t.svc.runAll()).servers).toBe(0);
    t.setConfig({ enabled: true, kind: 'audiobookshelf' });
    await expect(t.svc.preview('jf1')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(t.svc.preview('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    t.setConfig({ id: 'other', kind: 'jellyfin' });
    t.svc.prune();
    expect(t.svc.owned('jf1')).toEqual([]);
  });
});

describe('tag sync migration', () => {
  it('creates the tables', () => {
    const db: Db = openDatabase(':memory:');
    const names = db.$client
      .prepare("select name from sqlite_master where type = 'table' and name like 'media_server_tag_sync%'")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(names).toEqual(['media_server_tag_sync_state', 'media_server_tag_syncs']);
  });
});
