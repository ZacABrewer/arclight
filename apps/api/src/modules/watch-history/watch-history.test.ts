import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { MediaServerClient } from '@arclight/media-servers';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { mediaRequests, users } from '../../db/schema.js';
import { MediaServersService } from '../media-servers/index.js';
import { RetentionService } from '../retention/index.js';
import { setSection } from '../settings/service.js';
import { mediaServerUsers, watchEvents, watchState } from './schema.js';
import { WatchQueries } from './queries.js';
import { linkedUsers, WatchStore } from './store.js';
import { WatchSync, type AccountsPort } from './sync.js';
import { addMovie, addSeries, FakeJellyfin } from './test-support.js';

const ALICE = 'aaaaaaaa1111aaaa1111aaaaaaaaaaaa';
const BOB = 'bbbbbbbb2222bbbb2222bbbbbbbbbbbb';

function addUser(db: Db, username: string, opts: { link?: string; localPassword?: boolean } = {}): number {
  const now = new Date().toISOString();
  return db
    .insert(users)
    .values({
      username,
      usernameKey: username,
      passwordHash: 'x',
      role: 'user',
      permissions: 32,
      localPassword: opts.localPassword ?? false,
      settings: opts.link ? { mediaServerLink: { kind: 'jellyfin', externalId: opts.link, username, linkedAt: now } } : {},
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get().id;
}

async function harness(opts: { createUsers?: boolean } = {}) {
  const db = await createTestDb();
  const fake = new FakeJellyfin();
  let clock = new Date('2026-06-01T12:00:00Z');
  const now = () => clock;
  const servers = new MediaServersService({ db, fetch: fake.fetch, newId: () => 'jf1' });
  servers.create({ kind: 'jellyfin', name: 'Den', url: 'http://jellyfin.test', apiKey: fake.apiKey, usedForRetention: true, loginEnabled: true, createUsersOnLogin: opts.createUsers ?? false });
  const store = new WatchStore(db, now);
  const created: string[] = [];
  const revoked: number[] = [];
  const accounts: AccountsPort = {
    createLinkedUser: async (account, link) => {
      created.push(account.username);
      const nowIso = now().toISOString();
      const row = db
        .insert(users)
        .values({ username: account.username, usernameKey: account.username.toLowerCase(), passwordHash: 'x', role: 'user', permissions: 0, localPassword: false, settings: { mediaServerLink: link }, createdAt: nowIso, updatedAt: nowIso })
        .returning()
        .get();
      return { id: row.id };
    },
    patchUserSettings: (userId, patch) => {
      const row = db.select().from(users).where(eq(users.id, userId)).get()!;
      const settings: Record<string, unknown> = { ...(row.settings as Record<string, unknown>), ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete settings[k];
      db.update(users).set({ settings }).where(eq(users.id, userId)).run();
    },
    revokeSessions: (userId) => revoked.push(userId),
  };
  const sync = new WatchSync({ store, servers, accounts: () => accounts, now });
  const queries = new WatchQueries(db, () => servers.stored(), now);
  return {
    db,
    fake,
    servers,
    store,
    sync,
    queries,
    created,
    revoked,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    now,
  };
}

/** Library: one movie, one 2x2 series; Jellyfin: the same plus a movie Arclight does not have. */
function seed(h: Awaited<ReturnType<typeof harness>>) {
  const movieId = addMovie(h.db, 603, 'The Matrix');
  const seriesId = addSeries(h.db, 1399, 121361, 'Thrones', [2, 2]);
  h.fake
    .account(ALICE, 'alice')
    .account(BOB, 'bob')
    .item({ Id: 'm1', Name: 'The Matrix', Type: 'Movie', ProviderIds: { Tmdb: '603' }, RunTimeTicks: 81_600_000_000 })
    .item({ Id: 'm2', Name: 'Not In Library', Type: 'Movie', ProviderIds: { Tmdb: '999' } })
    .item({ Id: 's1', Name: 'Thrones', Type: 'Series', ProviderIds: { Tvdb: '121361' } });
  for (const season of [1, 2]) {
    for (const ep of [1, 2]) {
      h.fake.item({ Id: `e${season}${ep}`, Name: `S${season}E${ep}`, Type: 'Episode', SeriesId: 's1', SeasonId: `ss${season}`, ParentIndexNumber: season, IndexNumber: ep });
    }
  }
  return { movieId, seriesId };
}

describe('MediaServerWatchSync', () => {
  it('imports everything on the first run: movies, remembered episodes, roll-ups and played events', async () => {
    const h = await harness();
    const { movieId, seriesId } = seed(h);
    const aliceId = addUser(h.db, 'alice', { link: ALICE });
    h.fake.data(ALICE, 'm1', { Played: true, PlayCount: 2, LastPlayedDate: '2026-05-01T20:00:00Z' });
    for (const ep of ['e11', 'e12', 'e21', 'e22']) h.fake.data(ALICE, ep, { Played: true, LastPlayedDate: '2026-05-02T20:00:00Z' });
    h.fake.data(BOB, 'e11', { PlaybackPositionTicks: 6_000_000_000 });

    const result = await h.sync.syncWatch();
    expect(result.servers[0]).toMatchObject({ status: 'ok', users: 2 });
    expect(h.servers.stored()[0]!.remoteId).toBe(h.fake.serverId);

    const rows = h.db.select().from(watchState).all();
    // Movies: a row per account and visible movie; episodes: only remembered ones.
    expect(rows.filter((r) => r.itemType === 'movie')).toHaveLength(4);
    expect(rows.filter((r) => r.itemType === 'episode')).toHaveLength(5);
    const aliceAcct = h.db.select().from(mediaServerUsers).all().find((a) => a.externalId === ALICE)!;
    const movie = rows.find((r) => r.mediaServerUserId === aliceAcct.id && r.jellyfinItemId === 'm1')!;
    expect(movie).toMatchObject({ itemKey: `movie:${movieId}`, played: true, playCount: 2, durationMs: 8_160_000 });
    expect(rows.find((r) => r.jellyfinItemId === 'm2')!.itemKey).toBe('jf:m2');
    const series = rows.find((r) => r.mediaServerUserId === aliceAcct.id && r.itemType === 'series')!;
    expect(series).toMatchObject({ itemKey: `series:${seriesId}`, episodesTotal: 4, episodesPlayed: 4, played: true });
    const bobSeries = rows.find((r) => r.mediaServerUserId !== aliceAcct.id && r.itemType === 'series')!;
    expect(bobSeries).toMatchObject({ played: false, episodesPlayed: 0, positionMs: 600_000 });
    expect(rows.filter((r) => r.itemType === 'season' && r.mediaServerUserId === aliceAcct.id).map((r) => r.itemKey).sort()).toEqual([
      `season:${seriesId}:1`,
      `season:${seriesId}:2`,
    ]);

    const events = h.db.select().from(watchEvents).all();
    expect(events.filter((e) => e.type === 'played')).toHaveLength(5);
    expect(events.find((e) => e.jellyfinItemId === 'm1')).toMatchObject({ at: '2026-05-01T20:00:00.000Z', source: 'sync', movieId });

    // The linked account's history reads under the Arclight user; Bob (unlinked) keeps his.
    const page = h.queries.events({}, { isAdmin: false, userId: aliceId });
    expect(page.totalRecords).toBe(5);
    expect(page.records[0]!.user).toMatchObject({ arclightUserId: aliceId, arclightUsername: 'alice' });
    expect(h.queries.syncStatus(h.servers.stored()[0]!)).toMatchObject({ lastStatus: 'ok', users: 2, linkedUsers: 1 });
    expect(h.queries.syncStatus(h.servers.stored()[0]!).lastFullSyncAt).not.toBeNull();
  });

  it('pages full reads and never sends MinDateLastSavedForUser', async () => {
    const h = await harness();
    h.fake.account(ALICE, 'alice');
    for (let i = 0; i < 1100; i++) h.fake.item({ Id: `x${i}`, Name: `Movie ${i}`, Type: 'Movie', ProviderIds: { Tmdb: String(10_000 + i) } });
    await h.sync.syncWatch();
    const reads = h.fake.calls.filter((c) => c.path === `/Users/${ALICE}/Items`);
    expect(reads.map((c) => c.query.get('StartIndex'))).toEqual(['0', '500', '1000']);
    expect(reads.every((c) => !c.query.has('MinDateLastSavedForUser'))).toBe(true);
    expect(h.db.select().from(watchState).all()).toHaveLength(1100);
  });

  it('reads incrementally by DatePlayed between full reads and catches un-played changes on the next full read', async () => {
    const h = await harness();
    seed(h);
    h.fake.data(ALICE, 'm1', { Played: true, LastPlayedDate: '2026-05-01T20:00:00Z' });
    await h.sync.syncWatch();
    h.fake.calls.length = 0;

    h.advance(10 * 60_000);
    h.fake.data(ALICE, 'e11', { Played: true, PlayCount: 1, LastPlayedDate: '2026-06-01T12:05:00Z' });
    h.fake.data(ALICE, 'm1', { Played: false, PlayCount: 0 }); // "mark unplayed" keeps the old date
    const r = await h.sync.syncWatch();
    expect(r.servers[0]!.events).toBe(1);
    const reads = h.fake.calls.filter((c) => c.path === `/Users/${ALICE}/Items`);
    expect(reads[0]!.query.get('SortBy')).toBe('DatePlayed');
    expect(reads[0]!.query.get('SortOrder')).toBe('Descending');
    const aliceAcct = h.db.select().from(mediaServerUsers).all().find((a) => a.externalId === ALICE)!;
    expect(h.store.stateRow(aliceAcct.id, 'e11')!.played).toBe(true);
    expect(h.store.stateRow(aliceAcct.id, 's1')!.episodesPlayed).toBe(1);
    // The incremental read stopped before the older movie: still played here.
    expect(h.store.stateRow(aliceAcct.id, 'm1')!.played).toBe(true);

    await h.sync.syncWatch({ full: true });
    expect(h.store.stateRow(aliceAcct.id, 'm1')!.played).toBe(false);
    expect(h.db.select().from(watchEvents).all().filter((e) => e.type === 'unplayed')).toHaveLength(1);
  });

  it('reports a failing server without touching the stored state', async () => {
    const h = await harness();
    seed(h);
    await h.sync.syncWatch();
    const before = h.db.select().from(watchState).all().length;
    h.fake.down = true;
    const r = await h.sync.syncWatch();
    expect(r.servers[0]).toMatchObject({ status: 'failed' });
    expect(h.db.select().from(watchState).all()).toHaveLength(before);
    expect(h.queries.syncStatus(h.servers.stored()[0]!)).toMatchObject({ lastStatus: 'failed' });
  });
});

describe('MediaServerUserSync', () => {
  it('follows renames, disables and deletions; history stays with the account', async () => {
    const h = await harness();
    seed(h);
    const aliceId = addUser(h.db, 'alice', { link: ALICE });
    const bobId = addUser(h.db, 'bob', { link: BOB.toUpperCase().replace(/^(.{8})/, '$1-') });
    h.fake.data(BOB, 'm1', { Played: true, LastPlayedDate: '2026-05-01T20:00:00Z' });
    await h.sync.syncUsers();
    await h.sync.syncWatch();

    h.fake.accounts[0]!.Name = 'alice-renamed';
    h.fake.accounts[0]!.IsDisabled = true;
    h.fake.accounts.splice(1, 1); // bob deleted on the server
    const r = await h.sync.syncUsers();
    expect(r.servers[0]).toMatchObject({ status: 'ok', renamed: 1, disabled: 1, deleted: 1 });

    const alice = h.db.select().from(users).where(eq(users.id, aliceId)).get()!;
    expect((alice.settings as { mediaServerLink: { username: string } }).mediaServerLink.username).toBe('alice-renamed');
    expect(h.revoked).toEqual([aliceId]);
    const bob = h.db.select().from(users).where(eq(users.id, bobId)).get()!;
    expect((bob.settings as Record<string, unknown>)['mediaServerLink']).toBeUndefined();
    const accounts = h.queries.accounts('jf1');
    expect(accounts.find((a) => a.externalId === BOB)).toMatchObject({ deleted: true, arclightUserId: null });
    expect(accounts.find((a) => a.externalId === ALICE)).toMatchObject({ disabled: true, name: 'alice-renamed', arclightUserId: aliceId });
    // Bob's play is still stored under his account.
    const bobAcct = h.db.select().from(mediaServerUsers).all().find((a) => a.externalId === BOB)!;
    expect(h.store.stateRow(bobAcct.id, 'm1')!.played).toBe(true);
  });

  it('creates Arclight users for new accounts only when sign-in may create users', async () => {
    const h = await harness({ createUsers: true });
    h.fake.account(ALICE, 'alice');
    setSection(h.db, 'signIn', { local: true, jellyfin: true, emby: true, plex: true, newUsers: 'invite' });
    await h.sync.syncUsers();
    expect(h.created).toEqual([]);

    h.fake.account(BOB, 'bob');
    setSection(h.db, 'signIn', { local: true, jellyfin: true, emby: true, plex: true, newUsers: 'automatic' });
    const r = await h.sync.syncUsers();
    expect(r.servers[0]).toMatchObject({ added: 1, created: 1 });
    expect(h.created).toEqual(['bob']);
    expect(linkedUsers(h.db).has(`jellyfin:${BOB}`)).toBe(true);
    // A known account is never re-created.
    await h.sync.syncUsers();
    expect(h.created).toEqual(['bob']);
  });
});

describe('retention from stored watch history', () => {
  /** A client that fails if retention reads the server live. */
  const noLive = (config: { id: string; name: string }) =>
    ({
      config: { ...config, kind: 'jellyfin' },
      client: {
        users: async () => {
          throw new Error('live read');
        },
        listPlayStates: async () => {
          throw new Error('live read');
        },
      } as unknown as MediaServerClient,
    }) as never;

  async function retention() {
    const h = await harness();
    const { movieId, seriesId } = seed(h);
    const aliceId = addUser(h.db, 'alice', { link: ALICE });
    h.fake.data(ALICE, 'm1', { Played: true, LastPlayedDate: '2026-05-01T20:00:00Z' });
    for (const ep of ['e11', 'e12', 'e21', 'e22']) h.fake.data(ALICE, ep, { Played: true, LastPlayedDate: '2026-05-02T20:00:00Z' });
    await h.sync.syncWatch();
    const applied: number[] = [];
    const service = new RetentionService({
      db: h.db,
      servers: () => [noLive({ id: 'jf1', name: 'Den' })],
      watchSource: () => ({
        covered: () => h.queries.coveredServers({ syncIntervalMinutes: 10, fullSyncHours: 24, eventRetentionDays: 400 }),
        rows: (mediaType, ids) => h.queries.retentionRows(mediaType, ids),
        links: () => linkedUsers(h.db),
      }),
      apply: async (_a, _t, id) => {
        applied.push(id);
        return { freedBytes: 0, recycled: [] };
      },
      now: h.now,
    });
    return { h, service, movieId, seriesId, aliceId, applied };
  }

  it('evaluates watched rules without asking the server, merging linked accounts into their user', async () => {
    const { service, movieId, seriesId } = await retention();
    service.createRule({ name: 'Watched movies', mediaType: 'movie', conditions: [{ type: 'watchedByUsers', users: ['alice'] }], action: 'unmonitor' });
    service.createRule({ name: 'Watched series', mediaType: 'series', conditions: [{ type: 'watchedByAny' }], action: 'unmonitor' });
    service.createRule({ name: 'Everyone', mediaType: 'movie', conditions: [{ type: 'watchedByAll' }], action: 'unmonitor' });
    const r = await service.sweep({ dryRun: true });
    expect(r.serverErrors).toEqual([]);
    expect(r.rulesSkipped).toEqual([]);
    expect(r.matches.map((m) => [m.ruleName, m.mediaId])).toEqual([
      ['Watched movies', movieId],
      ['Watched series', seriesId],
    ]);
  });

  it('falls back to the live read when no full sync has finished', async () => {
    const { h, service } = await retention();
    h.db.update(mediaServerUsers).set({ lastFullSyncAt: null }).run();
    h.store.patchSyncState('jf1', { lastFullSyncAt: null });
    service.createRule({ name: 'Watched', mediaType: 'movie', conditions: [{ type: 'watchedByAny' }], action: 'unmonitor' });
    const r = await service.sweep({ dryRun: true });
    expect(r.serverErrors).toEqual([{ server: 'Den', message: 'live read' }]);
    expect(r.rulesSkipped).toHaveLength(1);
  });

  it('knows requesters: keeps unwatched requests and matches requests the requester ignored', async () => {
    const { h, service, aliceId } = await retention();
    const bobId = addUser(h.db, 'bob');
    const req = (userId: number, createdAt: string) =>
      h.db
        .insert(mediaRequests)
        .values({ type: 'movie', status: 'completed', tmdbId: 603, title: 'The Matrix', tags: [], requestedById: userId, is4k: false, createdAt, updatedAt: createdAt })
        .run();
    req(aliceId, '2026-01-01T00:00:00.000Z');
    service.createRule({ name: 'Watched, keep for requesters', mediaType: 'movie', conditions: [{ type: 'watchedByAny' }], action: 'unmonitor', keepIfRequesterHasNotWatched: true });
    service.createRule({ name: 'Requester lost interest', mediaType: 'movie', conditions: [{ type: 'notWatchedByRequesterWithinDays', days: 7 }], action: 'unmonitor' });
    let r = await service.sweep({ dryRun: true });
    // Alice requested and watched (May 1st; more than 7 days before June 1st).
    expect(r.matches.map((m) => m.ruleName).sort()).toEqual(['Requester lost interest', 'Watched, keep for requesters']);

    req(bobId, '2026-02-01T00:00:00.000Z'); // Bob has no linked account: never watched as far as we know
    r = await service.sweep({ dryRun: true });
    expect(r.matches.map((m) => m.ruleName)).toEqual([]);
  });
});
