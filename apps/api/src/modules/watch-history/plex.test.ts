import { and, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { users } from '../../db/schema.js';
import { MediaServersService } from '../media-servers/index.js';
import { setSection } from '../settings/service.js';
import { PlexLive } from './plex-live.js';
import { plexWebhookRoutes } from './plex-routes.js';
import { FakePlex, PLEX_URL, plexEvent, plexWebhookBody } from './plex-test-support.js';
import { WatchQueries } from './queries.js';
import { mediaServerUsers, watchEvents, watchState } from './schema.js';
import { linkedUsers, WatchStore } from './store.js';
import { WatchSync, type AccountsPort } from './sync.js';
import { addMovie, addSeries, episodeId } from './test-support.js';

const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function linkUser(db: Db, username: string, link: { externalId: string; accessToken?: string }): number {
  const now = new Date().toISOString();
  return db
    .insert(users)
    .values({
      username,
      usernameKey: username,
      passwordHash: 'x',
      role: 'user',
      permissions: 32,
      localPassword: false,
      settings: { mediaServerLink: { kind: 'plex', externalId: link.externalId, username, linkedAt: now, ...(link.accessToken ? { accessToken: link.accessToken } : {}) } },
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get().id;
}

async function harness(opts: { createUsers?: boolean } = {}) {
  const db = await createTestDb();
  const fake = new FakePlex();
  let clock = new Date('2026-06-01T12:00:00Z');
  const now = () => clock;
  let ids = 0;
  const servers = new MediaServersService({ db, fetch: fake.fetch as never, newId: () => (ids++ === 0 ? 'px1' : `srv${ids}`) });
  servers.create({ kind: 'plex', name: 'Attic', url: PLEX_URL, apiKey: fake.token, usedForRetention: true, loginEnabled: true, createUsersOnLogin: opts.createUsers ?? false });
  const store = new WatchStore(db, now);
  const created: Array<{ username: string; kind: string; externalId: string }> = [];
  const accounts: AccountsPort = {
    createLinkedUser: async (account, link) => {
      created.push({ username: account.username, kind: link.kind, externalId: link.externalId });
      const iso = now().toISOString();
      const row = db
        .insert(users)
        .values({ username: account.username, usernameKey: account.username.toLowerCase(), passwordHash: 'x', role: 'user', permissions: 0, localPassword: false, settings: { mediaServerLink: link }, createdAt: iso, updatedAt: iso })
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
    revokeSessions: () => undefined,
  };
  const sync = new WatchSync({ store, servers, accounts: () => accounts, now });
  const queries = new WatchQueries(db, () => servers.stored(), now);
  const live = new PlexLive(store, servers, undefined, now);
  return {
    db,
    fake,
    servers,
    store,
    sync,
    queries,
    live,
    created,
    now,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

type H = Awaited<ReturnType<typeof harness>>;

/** Library: The Matrix and a 2x2 Thrones; Plex: the same plus a movie Arclight does not have. Owner, dave (friend), Kids (managed). */
function seed(h: H) {
  const movieId = addMovie(h.db, 603, 'The Matrix');
  const seriesId = addSeries(h.db, 1399, 121361, 'Thrones', [2, 2]);
  h.fake.local = [{ id: '5', name: 'dave' }];
  h.fake.friends = [
    { id: '5', title: 'dave' },
    { id: '6', title: 'erin' },
    { id: '7', title: 'frank', machine: 'someotherserver' },
  ];
  h.fake.home = [{ id: '8', title: 'Kids', restricted: true }];
  // Matrix: new agent GUIDs; Other: legacy-only; Thrones: tvdb on the show, episodes matched by number.
  h.fake.movies = [
    { ratingKey: '11', title: 'The Matrix', guids: ['imdb://tt0133093', 'tmdb://603'], duration: 8_160_000 },
    { ratingKey: '12', title: 'Not In Library', guids: ['tmdb://999999'] },
  ];
  h.fake.shows = [
    {
      ratingKey: '20',
      title: 'Thrones',
      guids: ['tvdb://121361', 'tmdb://1399'],
      seasons: { 1: '21', 2: '22' },
      episodes: [
        { ratingKey: '201', title: 'S1E1', season: 1, index: 1 },
        { ratingKey: '202', title: 'S1E2', season: 1, index: 2 },
        { ratingKey: '203', title: 'S2E1', season: 2, index: 1 },
        { ratingKey: '204', title: 'S2E2', season: 2, index: 2 },
      ],
    },
  ];
  return { movieId, seriesId };
}

const row = (h: H, externalId: string) => h.db.select().from(mediaServerUsers).where(eq(mediaServerUsers.externalId, externalId)).get()!;
const state = (h: H, accountId: number, item: string) =>
  h.db.select().from(watchState).where(and(eq(watchState.mediaServerUserId, accountId), eq(watchState.jellyfinItemId, item))).get();

describe('Plex users', () => {
  it('syncs the owner, friends sharing this server and Home users, keyed by plex.tv id', async () => {
    const h = await harness();
    seed(h);
    const r = await h.sync.syncUsers();
    expect(r.servers[0]).toMatchObject({ status: 'ok', added: 4, deleted: 0 });
    const rows = h.db.select().from(mediaServerUsers).all();
    expect(rows.map((x) => [x.externalId, x.localId, x.name, x.isAdmin]).sort()).toEqual([
      ['5', '5', 'dave', false],
      ['6', '6', 'erin', false],
      ['8', '8', 'Kids', false],
      ['9000001', '1', 'owner', true],
    ]);
  });

  it('marks friends gone only when plex.tv answered', async () => {
    const h = await harness();
    seed(h);
    await h.sync.syncUsers();
    h.fake.friends = h.fake.friends.filter((f) => f.id !== '6');
    h.fake.plexTvDown = true;
    const offline = await h.sync.syncUsers();
    expect(offline.servers[0]).toMatchObject({ status: 'ok', deleted: 0 });
    // The owner kept its plex.tv id from the last read.
    expect(row(h, '9000001').localId).toBe('1');
    expect(row(h, '6').deleted).toBe(false);
    h.fake.plexTvDown = false;
    const online = await h.sync.syncUsers();
    expect(online.servers[0]).toMatchObject({ deleted: 1 });
    expect(row(h, '6').deleted).toBe(true);
  });

  it('syncs the server accounts without plex.tv on the first run and adds the owner later', async () => {
    const h = await harness();
    seed(h);
    h.fake.plexTvDown = true;
    const first = await h.sync.syncUsers();
    expect(first.servers[0]).toMatchObject({ status: 'ok', deleted: 0 });
    expect(h.db.select().from(mediaServerUsers).all().map((u) => u.externalId)).not.toContain('9000001');
    const watch = await h.sync.syncWatch({ full: true });
    expect(watch.servers[0]?.status).toBe('ok');
    h.fake.plexTvDown = false;
    await h.sync.syncUsers();
    expect(row(h, '9000001').localId).toBe('1');
  });

  it('creates linked Arclight users for new Plex accounts when sign-in allows it, and links Plex sign-ins by plex.tv id', async () => {
    const h = await harness({ createUsers: true });
    seed(h);
    setSection(h.db, 'signIn', { local: true, jellyfin: true, emby: true, plex: true, newUsers: 'automatic' });
    await h.sync.syncUsers();
    expect(h.created.map((c) => [c.username, c.kind, c.externalId]).sort()).toEqual([
      ['Kids', 'plex', '8'],
      ['dave', 'plex', '5'],
      ['erin', 'plex', '6'],
      ['owner', 'plex', '9000001'],
    ]);
    const links = linkedUsers(h.db);
    expect(links.get('plex:5')?.username).toBe('dave');
    // A second run creates nobody new.
    await h.sync.syncUsers();
    expect(h.created).toHaveLength(4);
  });

  it('does not create users when Plex sign-in is off', async () => {
    const h = await harness({ createUsers: true });
    seed(h);
    setSection(h.db, 'signIn', { local: true, jellyfin: true, emby: true, plex: false, newUsers: 'automatic' });
    await h.sync.syncUsers();
    expect(h.created).toHaveLength(0);
  });
});

describe('Plex watch history', () => {
  it("copies the owner's play state and matches items by GUID", async () => {
    const h = await harness();
    const { movieId, seriesId } = seed(h);
    h.fake.setState('owner', '11', { viewCount: 2, lastViewedAt: secs('2026-05-30T20:00:00Z') });
    h.fake.setState('owner', '201', { viewCount: 1, lastViewedAt: secs('2026-05-29T20:00:00Z') });
    h.fake.setState('owner', '202', { viewOffset: 600_000, lastViewedAt: secs('2026-05-31T20:00:00Z') });
    const r = await h.sync.syncWatch();
    expect(r.servers[0]).toMatchObject({ status: 'ok', users: 4 });
    const owner = row(h, '9000001');
    expect(state(h, owner.id, '11')).toMatchObject({ movieId, played: true, playCount: 2, lastPlayedAt: '2026-05-30T20:00:00.000Z', tmdbId: 603 });
    expect(state(h, owner.id, '12')).toMatchObject({ movieId: null, itemKey: 'jf:12', played: false });
    expect(state(h, owner.id, '201')).toMatchObject({ seriesId, episodeId: episodeId(h.db, seriesId, 1, 1), played: true, jellyfinSeriesId: '20', jellyfinSeasonId: '21' });
    expect(state(h, owner.id, '202')).toMatchObject({ episodeId: episodeId(h.db, seriesId, 1, 2), played: false, positionMs: 600_000 });
    expect(state(h, owner.id, '20')).toMatchObject({ itemType: 'series', seriesId, episodesTotal: 4, episodesPlayed: 1, played: false });
    // Played flips are on the timeline.
    const played = h.db.select().from(watchEvents).where(eq(watchEvents.type, 'played')).all();
    expect(played.map((e) => e.jellyfinItemId).sort()).toEqual(['11', '201']);
    expect(h.queries.syncStatus(h.servers.stored()[0]!)).toMatchObject({ watchSyncEnabled: true, lastStatus: 'ok', users: 4 });
  });

  it("derives other accounts' state from the server's watch history", async () => {
    const h = await harness();
    const { seriesId } = seed(h);
    await h.sync.syncUsers();
    h.fake.watched('5', '11', secs('2026-05-20T20:00:00Z')).watched('5', '11', secs('2026-05-25T20:00:00Z'));
    for (const ep of ['201', '202', '203', '204']) h.fake.watched('5', ep, secs('2026-05-26T20:00:00Z'));
    await h.sync.syncWatch();
    const dave = row(h, '5');
    expect(state(h, dave.id, '11')).toMatchObject({ played: true, playCount: 2, lastPlayedAt: '2026-05-25T20:00:00.000Z' });
    expect(state(h, dave.id, '20')).toMatchObject({ seriesId, episodesTotal: 4, episodesPlayed: 4, played: true });
    const erin = row(h, '6');
    expect(state(h, erin.id, '11')).toMatchObject({ played: false });
    // Every account had a full read: retention may trust stored state.
    const covered = h.queries.coveredServers({ syncIntervalMinutes: 15, fullSyncHours: 24, eventRetentionDays: 365 } as never);
    expect([...covered]).toEqual(['px1']);
    const rows = h.queries.retentionRows('movie', covered);
    expect(rows.filter((x) => x.played).map((x) => x.account.name)).toEqual(['dave']);
  });

  it('reads only new plays on an incremental run and keeps resume points the history does not have', async () => {
    const h = await harness();
    seed(h);
    await h.sync.syncUsers();
    await h.sync.syncWatch();
    const dave = row(h, '5');
    // A webhook-style resume point for dave.
    h.store.applyState(
      { serverId: 'px1', mediaServerUserId: dave.id, jellyfinItemId: '11', resolved: { ...state(h, dave.id, '11')!, seriesTitle: null }, title: 'The Matrix', positionMs: 1_234_000 },
      { source: 'webhook' },
    );
    h.advance(60 * 60_000);
    h.fake.watched('5', '201', secs(h.now().toISOString()) - 60);
    h.fake.calls.length = 0;
    await h.sync.syncWatch();
    expect(state(h, dave.id, '201')).toMatchObject({ played: true, playCount: 1 });
    expect(state(h, dave.id, '11')).toMatchObject({ positionMs: 1_234_000 });
    // No full listing for dave on the incremental run (the owner's own read sorts by lastViewedAt).
    expect(h.fake.calls.filter((c) => c.path.startsWith('/library/sections/') && c.path.endsWith('/all') && c.query.get('type') !== null && c.query.get('sort') === null)).toHaveLength(0);
  });

  it("reads a linked user's own resume points with their Plex token", async () => {
    const h = await harness();
    seed(h);
    linkUser(h.db, 'erin', { externalId: '6', accessToken: 'erin-plex-tv-token' });
    h.fake.userTokens.set('erin-plex-tv-token', 'erin-server-token');
    h.fake.setState('erin-server-token', '11', { viewOffset: 3_000_000, lastViewedAt: secs('2026-05-31T21:00:00Z') });
    await h.sync.syncUsers();
    await h.sync.syncWatch();
    const erin = row(h, '6');
    expect(state(h, erin.id, '11')).toMatchObject({ positionMs: 3_000_000, played: false });
    expect(h.fake.calls.some((c) => c.token === 'erin-server-token')).toBe(true);
    // The history shows erin's watches under her Arclight user.
    const owners = h.queries.owners();
    expect(owners.get(erin.id)?.username).toBe('erin');
  });

  it('falls back to the history when a linked token no longer works', async () => {
    const h = await harness();
    seed(h);
    linkUser(h.db, 'erin', { externalId: '6', accessToken: 'revoked-token' });
    h.fake.watched('6', '11', secs('2026-05-31T21:00:00Z'));
    await h.sync.syncUsers();
    const r = await h.sync.syncWatch();
    expect(r.servers[0]?.status).toBe('ok');
    expect(state(h, row(h, '6').id, '11')).toMatchObject({ played: true });
  });

  it('reports a failed server and keeps going', async () => {
    const h = await harness();
    seed(h);
    h.servers.update('px1', { kind: 'plex', name: 'Attic', url: PLEX_URL, apiKey: 'wrong-token', usedForRetention: true });
    const r = await h.sync.syncWatch();
    expect(r.servers[0]).toMatchObject({ status: 'failed' });
  });
});

describe('Plex live playback', () => {
  async function synced() {
    const h = await harness();
    const lib = seed(h);
    await h.sync.syncUsers();
    await h.sync.syncWatch();
    return { h, ...lib };
  }

  it('turns webhooks into start/progress/stop events and marks played on scrobble', async () => {
    const { h, movieId } = await synced();
    const config = h.servers.stored()[0]!;
    const who = { accountId: '5', accountName: 'dave', player: 'tv1', ratingKey: '11' };
    const send = async (event: string, viewOffset: number) => {
      const parsed = (await import('@arclight/media-servers')).parsePlexWebhook(plexEvent(event, h.fake, { ...who, viewOffset }));
      return h.live.webhook(config, parsed!);
    };
    expect(await send('media.play', 0)).toEqual({ status: 'stored' });
    expect(h.queries.nowPlaying()).toMatchObject([{ user: { name: 'dave' }, movieId, title: 'The Matrix' }]);
    h.advance(30_000);
    await send('media.pause', 30_000); // within a minute: not stored, resume point still moves
    h.advance(10 * 60_000);
    await send('media.resume', 630_000);
    h.advance(60 * 60_000);
    await send('media.scrobble', 7_400_000);
    await send('media.stop', 7_500_000);
    await send('media.stop', 7_500_000); // a repeat is dropped
    const events = h.db.select().from(watchEvents).where(eq(watchEvents.jellyfinItemId, '11')).all();
    expect(events.filter((e) => e.source === 'webhook').map((e) => e.type)).toEqual(['start', 'progress', 'played', 'stop']);
    expect(events.every((e) => e.sessionId === null || e.sessionId === 'plex:px1:tv1:11')).toBe(true);
    const dave = row(h, '5');
    expect(state(h, dave.id, '11')).toMatchObject({ played: true, playCount: 1, movieId });
    expect(h.queries.nowPlaying()).toEqual([]);
    expect(h.queries.syncStatus(config).lastEventAt).not.toBeNull();
  });

  it('ignores events of another server, non-playback events and the anonymous account', async () => {
    const { h } = await synced();
    const config = h.servers.stored()[0]!;
    const { parsePlexWebhook } = await import('@arclight/media-servers');
    const base = plexEvent('media.play', h.fake, { accountId: '5', accountName: 'dave', player: 'tv1', ratingKey: '11' });
    expect(await h.live.webhook(config, parsePlexWebhook({ ...base, Server: { uuid: 'elsewhere' } })!)).toMatchObject({ status: 'ignored' });
    expect(await h.live.webhook(config, parsePlexWebhook({ ...base, event: 'library.new' })!)).toMatchObject({ status: 'ignored' });
    expect(await h.live.webhook(config, parsePlexWebhook({ ...base, Account: { id: 0, title: '' } })!)).toMatchObject({ status: 'ignored' });
    expect(h.db.select().from(watchEvents).where(eq(watchEvents.source, 'webhook')).all()).toHaveLength(0);
  });

  it('maps the owner (local id 1) to the synced owner row and resolves episodes through their show', async () => {
    const { h, seriesId } = await synced();
    const config = h.servers.stored()[0]!;
    const { parsePlexWebhook } = await import('@arclight/media-servers');
    await h.live.webhook(config, parsePlexWebhook(plexEvent('media.play', h.fake, { accountId: '1', accountName: 'owner', player: 'web', ratingKey: '203' }))!);
    const e = h.db.select().from(watchEvents).where(eq(watchEvents.source, 'webhook')).get()!;
    expect(e).toMatchObject({ mediaServerUserId: row(h, '9000001').id, seriesId, episodeId: episodeId(h.db, seriesId, 2, 1), type: 'start' });
  });

  it('polls sessions: starts, progress, and a stop (played past 90%) when the session ends', async () => {
    const { h, seriesId } = await synced();
    h.fake.sessions = [{ sessionKey: '1', ratingKey: '204', accountId: '5', accountName: 'dave', player: 'tv1', viewOffset: 60_000, transcode: true }];
    expect(await h.live.poll()).toBe('Attic: 1 playing, 0 stopped');
    h.advance(60_000);
    h.fake.sessions[0]!.viewOffset = 2_600_000;
    await h.live.poll();
    h.advance(60_000);
    h.fake.sessions = [];
    expect(await h.live.poll()).toBe('Attic: 0 playing, 1 stopped');
    const events = h.db.select().from(watchEvents).where(eq(watchEvents.jellyfinItemId, '204')).all();
    expect(events.map((e) => [e.type, e.source])).toEqual([
      ['start', 'poll'],
      ['progress', 'poll'],
      ['stop', 'poll'],
      ['played', 'poll'],
    ]);
    expect(events[0]).toMatchObject({ playMethod: 'Transcode', device: 'tv1 device', episodeId: episodeId(h.db, seriesId, 2, 2) });
    const dave = row(h, '5');
    expect(state(h, dave.id, '204')).toMatchObject({ played: true, playCount: 1, jellyfinSeriesId: '20' });
    // Nothing more to stop.
    expect(await h.live.poll()).toBe('Attic: 0 playing, 0 stopped');
  });

  it('merges webhooks and polling into one session and counts a scrobbled play once', async () => {
    const { h } = await synced();
    const config = h.servers.stored()[0]!;
    const { parsePlexWebhook } = await import('@arclight/media-servers');
    const who = { accountId: '5', accountName: 'dave', player: 'tv1', ratingKey: '11' };
    await h.live.webhook(config, parsePlexWebhook(plexEvent('media.play', h.fake, who))!);
    h.fake.sessions = [{ sessionKey: '1', ratingKey: '11', accountId: '5', accountName: 'dave', player: 'tv1', viewOffset: 7_500_000 }];
    h.advance(2 * 60_000);
    await h.live.poll(); // progress, not a second start
    await h.live.webhook(config, parsePlexWebhook(plexEvent('media.scrobble', h.fake, { ...who, viewOffset: 7_500_000 }))!);
    h.advance(60_000);
    h.fake.sessions = [];
    await h.live.poll(); // stop from the poll; the play was already counted
    const types = h.db.select().from(watchEvents).where(eq(watchEvents.jellyfinItemId, '11')).all().map((e) => e.type);
    expect(types).toEqual(['start', 'progress', 'played', 'stop']);
    expect(state(h, row(h, '5').id, '11')).toMatchObject({ playCount: 1 });
  });
});

describe('Plex webhook route', () => {
  async function app() {
    const h = await harness();
    seed(h);
    await h.sync.syncUsers();
    const server = Fastify().withTypeProvider<ZodTypeProvider>();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    await server.register(plexWebhookRoutes(h.servers, h.live), { prefix: '/api/v1' });
    return { h, server };
  }

  it('gives a stable webhook URL, rotates it, and keeps the token out of the connection list', async () => {
    const { h, server } = await app();
    const first = (await server.inject({ method: 'GET', url: '/api/v1/mediaserver/px1/plexwebhook' })).json();
    expect(first.path).toBe(`/api/v1/plex/webhook?token=${first.token}`);
    expect((await server.inject({ method: 'GET', url: '/api/v1/mediaserver/px1/plexwebhook' })).json().token).toBe(first.token);
    expect(JSON.stringify(h.servers.list())).not.toContain(first.token);
    // Editing the connection keeps the URL.
    h.servers.update('px1', { kind: 'plex', name: 'Attic 2', url: PLEX_URL, apiKey: h.fake.token, usedForRetention: true });
    expect((await server.inject({ method: 'GET', url: '/api/v1/mediaserver/px1/plexwebhook' })).json().token).toBe(first.token);
    const next = (await server.inject({ method: 'POST', url: '/api/v1/mediaserver/px1/plexwebhook/regenerate' })).json();
    expect(next.token).not.toBe(first.token);
    const old = await server.inject({ method: 'POST', url: `/api/v1/plex/webhook?token=${first.token}`, ...plexWebhookBody({ event: 'media.play' }) });
    expect(old.statusCode).toBe(401);
  });

  it('accepts multipart webhooks (with a thumbnail) and stores the event', async () => {
    const { h, server } = await app();
    const { token } = (await server.inject({ method: 'GET', url: '/api/v1/mediaserver/px1/plexwebhook' })).json();
    const body = plexWebhookBody(plexEvent('media.play', h.fake, { accountId: '5', accountName: 'dave', player: 'tv1', ratingKey: '11' }), { thumb: true });
    const res = await server.inject({ method: 'POST', url: `/api/v1/plex/webhook?token=${token}`, ...body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'stored' });
    expect(h.db.select().from(watchEvents).where(eq(watchEvents.source, 'webhook')).all()).toHaveLength(1);
    const bad = await server.inject({ method: 'POST', url: `/api/v1/plex/webhook?token=${token}`, ...plexWebhookBody({ nope: true }) });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses webhook URLs for non-Plex servers', async () => {
    const { h, server } = await app();
    h.servers.create({ kind: 'jellyfin', name: 'Den', url: 'http://jellyfin.test', apiKey: 'k' });
    const id = h.servers.stored().find((s) => s.kind === 'jellyfin')!.id;
    expect((await server.inject({ method: 'GET', url: `/api/v1/mediaserver/${id}/plexwebhook` })).statusCode).toBe(400);
  });
});
