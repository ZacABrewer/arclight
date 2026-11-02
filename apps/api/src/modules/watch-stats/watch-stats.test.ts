import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { Permission } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { movies, series } from '../../db/schema.js';
import { authServiceFor, installAuth } from '../auth/index.js';
import { jellyfinPluginModule } from '../jellyfin-plugin/index.js';
import { MediaServersService, setMediaServersService } from '../media-servers/index.js';
import { requestsModuleWith } from '../requests/index.js';
import { addUser, setup } from '../requests/test-support.js';
import { setSection } from '../settings/service.js';
import { mediaServerUsers, watchEvents, watchHistoryModule } from '../watch-history/index.js';
import { addMovie, addSeries, FakeJellyfin } from '../watch-history/test-support.js';
import { collectionsModule } from '../collections/index.js';
import { wrappedSvg } from './card.js';
import { WatchStatsService, type Owner } from './service.js';
import { WrappedShares } from './shares.js';
import { watchStatsModule } from './index.js';

const MIN = 60_000;
const ALICE = 'aaaaaaaa1111aaaa1111aaaaaaaaaaaa';
const BOB = 'bbbbbbbb2222bbbb2222bbbbbbbbbbbb';

let dedupe = 0;
function account(db: Db, externalId: string, name: string, isAdmin = false): number {
  return db
    .insert(mediaServerUsers)
    .values({ serverId: 'jf1', externalId, name, isAdmin, firstSeenAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    .returning()
    .get().id;
}

interface PlayOpts {
  account: number;
  startMs: number;
  minutes: number;
  item: { itemType: 'movie' | 'episode'; itemKey: string; title: string; movieId?: number; seriesId?: number; seriesTitle?: string };
  playMethod?: 'DirectPlay' | 'DirectStream' | 'Transcode';
  device?: string;
  finished?: boolean;
}

/** A plugin session: start, a progress row per 10 minutes, stop (and played when finished). */
function play(db: Db, o: PlayOpts): void {
  const session = `s${++dedupe}`;
  const base = {
    serverId: 'jf1',
    mediaServerUserId: o.account,
    itemType: o.item.itemType,
    itemKey: o.item.itemKey,
    title: o.item.title,
    seriesTitle: o.item.seriesTitle ?? null,
    movieId: o.item.movieId ?? null,
    seriesId: o.item.seriesId ?? null,
    durationMs: 120 * MIN,
    client: 'Jellyfin Web',
    device: o.device ?? 'Firefox',
    playMethod: o.playMethod ?? 'DirectPlay',
    sessionId: session,
    source: 'plugin' as const,
  };
  const rows: { type: 'start' | 'progress' | 'stop' | 'played'; offset: number }[] = [{ type: 'start', offset: 0 }];
  for (let m = 10; m < o.minutes; m += 10) rows.push({ type: 'progress', offset: m });
  rows.push({ type: 'stop', offset: o.minutes });
  if (o.finished) rows.push({ type: 'played', offset: o.minutes });
  for (const r of rows) {
    db.insert(watchEvents)
      .values({ ...base, type: r.type, at: new Date(o.startMs + r.offset * MIN).toISOString(), positionMs: r.offset * MIN, dedupeKey: `d${++dedupe}` })
      .run();
  }
}

function setGenres(db: Db, movieId: number, genres: string[]): void {
  db.update(movies).set({ genres }).where(eq(movies.id, movieId)).run();
}

describe('WatchStatsService', () => {
  async function seeded() {
    const h = await setup();
    const now = new Date(2026, 10, 2, 22, 0, 0); // local time
    const a = account(h.db, ALICE, 'alice');
    const b = account(h.db, BOB, 'bob');
    const alice = addUser(h.db, { username: 'alice' });
    const owners = new Map<number, Owner | null>([
      [a, { id: alice.id, username: 'alice', displayName: null }],
      [b, null],
    ]);
    const m1 = addMovie(h.db, 101, 'Night Train');
    const m2 = addMovie(h.db, 102, 'Paper Moon');
    setGenres(h.db, m1, ['Thriller', 'Drama']);
    setGenres(h.db, m2, ['Drama']);
    const s1 = addSeries(h.db, 201, 301, 'Harbour Lights', [3]);
    h.db.update(series).set({ genres: ['Comedy'] }).where(eq(series.id, s1)).run();
    const svc = new WatchStatsService({ db: h.db, owners: () => owners, now: () => now });
    const day = (daysAgo: number, hour: number) => new Date(2026, 10, 2 - daysAgo, hour, 0, 0).getTime();
    const movie1 = { itemType: 'movie' as const, itemKey: `movie:${m1}`, title: 'Night Train', movieId: m1 };
    const movie2 = { itemType: 'movie' as const, itemKey: `movie:${m2}`, title: 'Paper Moon', movieId: m2 };
    const ep = (n: number) => ({ itemType: 'episode' as const, itemKey: `episode:${n}`, title: `Episode ${n}`, seriesId: s1, seriesTitle: 'Harbour Lights' });
    play(h.db, { account: a, startMs: day(1, 20), minutes: 90, item: movie1, finished: true });
    play(h.db, { account: a, startMs: day(2, 21), minutes: 30, item: ep(1), playMethod: 'Transcode', device: 'Living room TV' });
    play(h.db, { account: a, startMs: day(2, 21) + 40 * MIN, minutes: 30, item: ep(2), playMethod: 'Transcode', device: 'Living room TV' });
    play(h.db, { account: b, startMs: day(3, 19), minutes: 60, item: movie1, playMethod: 'DirectStream' });
    play(h.db, { account: b, startMs: day(3, 21), minutes: 45, item: movie2 });
    // Outside a 7 day window, inside the year.
    play(h.db, { account: a, startMs: new Date(2026, 1, 14, 18).getTime(), minutes: 100, item: movie2, finished: true });
    // Last year.
    play(h.db, { account: a, startMs: new Date(2025, 5, 1, 18).getTime(), minutes: 50, item: movie2 });
    return { ...h, svc, alice, a, b, m1, s1, day };
  }

  it('builds server-wide stats: totals, play methods, top titles, genres, heatmap, users', async () => {
    const t = await seeded();
    const s = t.svc.stats({ days: 7 }, null, { withUsers: true });
    expect(s.totals).toEqual({ plays: 5, watchMs: (90 + 30 + 30 + 60 + 45) * MIN, titles: 3, users: 2, movies: 3, episodes: 2 });
    expect(s.playMethods).toEqual({ directPlay: 2, directStream: 1, transcode: 2, unknown: 0 });
    expect(s.topMovies[0]).toMatchObject({ title: 'Night Train', plays: 2, users: 2, watchMs: 150 * MIN });
    expect(s.topSeries).toEqual([expect.objectContaining({ title: 'Harbour Lights', plays: 2, seriesId: t.s1 })]);
    expect(s.topGenres.map((g) => g.name)).toEqual(expect.arrayContaining(['Drama', 'Thriller', 'Comedy']));
    expect(s.topGenres[0]!.name).toBe('Drama');
    expect(s.devices[0]).toMatchObject({ name: 'Firefox' });
    expect(s.perDay).toHaveLength(7);
    expect(s.perDay.reduce((n, d) => n + d.plays, 0)).toBe(5);
    const at = new Date(t.day(1, 20));
    expect(s.heatmap[at.getDay()]![at.getHours()]).toBe(1);
    expect(s.users.map((u) => u.name).sort()).toEqual(['alice', 'bob']);
    expect(s.users.find((u) => u.name === 'alice')).toMatchObject({ arclightUserId: t.alice.id, plays: 3 });
  });

  it('scopes stats to one user and leaves the user list out when asked', async () => {
    const t = await seeded();
    const s = t.svc.stats({ days: 7 }, t.alice.id, { withUsers: false });
    expect(s.totals.plays).toBe(3);
    expect(s.users).toEqual([]);
    expect(t.svc.stats({ days: 7 }, 9999).totals.plays).toBe(0);
  });

  it('builds a Year in review', async () => {
    const t = await seeded();
    const w = t.svc.wrapped(t.alice.id, 2026);
    expect(w).toMatchObject({ year: 2026, name: 'alice', plays: 4, movies: 2, episodes: 2, series: 1, activeDays: 3, topDevice: 'Firefox' });
    expect(w.watchMs).toBe((90 + 30 + 30 + 100) * MIN);
    expect(w.busiestMonth).toBe(2);
    expect(w.firstPlay?.title).toBe('Paper Moon');
    expect(w.monthly[10]).toBe(90 * MIN);
    expect(w.monthly[9]).toBe(60 * MIN);
    expect(w.percentile).toBe(100);
    expect(w.years).toEqual([2026, 2025]);
    expect(t.svc.wrapped(t.alice.id, 2025)).toMatchObject({ plays: 1, watchMs: 50 * MIN, percentile: null });
  });

  it('renders the Wrapped card as escaped SVG', async () => {
    const t = await seeded();
    const w = { ...t.svc.wrapped(t.alice.id, 2026), name: '<script>alert(1)</script>' };
    const svg = wrappedSvg(w);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});

describe('WrappedShares', () => {
  it('creates, resolves, expires and prunes share links', async () => {
    const h = await setup();
    const u = addUser(h.db, { username: 'sharer' });
    let now = new Date('2026-11-01T12:00:00.000Z');
    const shares = new WrappedShares(h.db, () => now, () => 'https://arclight.example.com/');
    const s = shares.create(u.id, 2026, 14);
    expect(s.url).toBe(`https://arclight.example.com/api/v1/share/wrapped/${s.path.split('/').pop()}`);
    const token = s.path.split('/').pop()!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(shares.resolve(token)?.userId).toBe(u.id);
    expect(shares.resolve('../etc/passwd')).toBeUndefined();
    expect(shares.list(u.id)).toHaveLength(1);
    now = new Date('2026-11-16T12:00:00.000Z');
    expect(shares.resolve(token)).toBeUndefined();
    expect(shares.list(u.id)).toHaveLength(0);
    expect(shares.prune()).toBe(1);
  });
});

describe('watch stats routes', () => {
  async function build() {
    const h = await setup();
    const fake = new FakeJellyfin();
    const servers = new MediaServersService({ db: h.db, fetch: fake.fetch, newId: () => 'jf1' });
    setMediaServersService(h.ctx, servers);
    servers.create({ kind: 'jellyfin', name: 'Den', url: 'http://jellyfin.test', apiKey: fake.apiKey, loginEnabled: true, createUsersOnLogin: false });
    servers.rememberRemoteId('jf1', fake.serverId);
    addUser(h.db, { role: 'admin', username: 'owner' });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(
      async (api) => {
        installAuth(api, h.ctx);
        await api.register(requestsModuleWith({})(h.ctx));
        await api.register(watchHistoryModule(h.ctx));
        await api.register(jellyfinPluginModule(h.ctx));
        await api.register(watchStatsModule(h.ctx));
        await api.register(collectionsModule(h.ctx));
      },
      { prefix: '/api/v1' },
    );
    await app.ready();
    const auth = authServiceFor(h.ctx);
    const key = auth.createPluginKey('test').key;
    const link = (externalId: string, username: string) => ({ mediaServerLink: { kind: 'jellyfin', externalId, username, linkedAt: '2026-01-01T00:00:00.000Z' } });
    const alice = addUser(h.db, { username: 'alice', permissions: Permission.REQUEST, settings: link(ALICE, 'alice') });
    const bob = addUser(h.db, { username: 'bob', permissions: Permission.REQUEST, settings: link(BOB, 'bob') });
    const a = account(h.db, ALICE, 'alice');
    const b = account(h.db, BOB, 'bob', true);
    const m1 = addMovie(h.db, 101, 'Night Train');
    const hourAgo = Date.now() - 3 * 60 * MIN;
    play(h.db, { account: a, startMs: hourAgo, minutes: 60, item: { itemType: 'movie', itemKey: `movie:${m1}`, title: 'Night Train', movieId: m1 } });
    play(h.db, { account: b, startMs: hourAgo, minutes: 20, item: { itemType: 'movie', itemKey: `movie:${m1}`, title: 'Night Train', movieId: m1 } });
    const as = (user?: string) => ({ 'x-api-key': key, ...(user ? { 'x-arclight-jellyfin-user': user } : {}) });
    return { ...h, app, as, alice, bob, adminKey: auth.apiKey() };
  }

  it('serves admin stats, growth and settings, and validates settings', async () => {
    const t = await build();
    const admin = { 'x-api-key': t.adminKey };
    const s = await t.app.inject({ method: 'GET', url: '/api/v1/watchstats?days=7', headers: admin });
    expect(s.statusCode).toBe(200);
    expect(s.json().totals).toMatchObject({ plays: 2, users: 2 });
    const mine = await t.app.inject({ method: 'GET', url: `/api/v1/watchstats?days=7&userId=${t.alice.id}`, headers: admin });
    expect(mine.json().totals.plays).toBe(1);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/watchstats/growth?days=30', headers: admin })).json().added).toEqual(expect.any(Array));
    const settings = (await t.app.inject({ method: 'GET', url: '/api/v1/settings/watchstats', headers: admin })).json();
    expect(settings.jellyfin.serverStats).toBe('admins');
    const bad = await t.app.inject({ method: 'PUT', url: '/api/v1/settings/watchstats', headers: admin, payload: { ...settings, wrapped: { ...settings.wrapped, shareLinkDays: 0 } } });
    expect(bad.statusCode).toBe(400);
  });

  it('gives the plugin per-user stats and gates server stats by audience', async () => {
    const t = await build();
    const access = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/stats/access', headers: t.as(ALICE) });
    expect(access.json()).toMatchObject({ myStats: true, wrapped: true, serverStats: false, isAdmin: false });
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/stats/me?days=7', headers: t.as(ALICE) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ totals: { plays: 1, watchMs: 60 * MIN }, users: [] });
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/stats/server', headers: t.as(ALICE) })).statusCode).toBe(403);
    // Bob is a Jellyfin administrator: server stats with names.
    const server = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/stats/server?days=7', headers: t.as(BOB) });
    expect(server.statusCode).toBe(200);
    expect(server.json().users).toHaveLength(2);
    // Everyone may see server stats, without names.
    const current = (await t.app.inject({ method: 'GET', url: '/api/v1/settings/watchstats', headers: { 'x-api-key': t.adminKey } })).json();
    setSection(t.db, 'watchStats', { ...current, jellyfin: { ...current.jellyfin, serverStats: 'everyone', myStats: false } });
    const open = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/stats/server?days=7', headers: t.as(ALICE) });
    expect(open.statusCode).toBe(200);
    expect(open.json().users).toEqual([]);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/stats/me', headers: t.as(ALICE) })).statusCode).toBe(403);
    // Unknown Jellyfin user.
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/stats/me', headers: t.as('ffff') })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('serves Wrapped to the plugin and a public share link that expires with revocation', async () => {
    const t = await build();
    const year = new Date().getFullYear();
    const w = await t.app.inject({ method: 'GET', url: `/api/v1/jellyfin/wrapped?year=${year}`, headers: t.as(ALICE) });
    expect(w.statusCode).toBe(200);
    expect(w.json()).toMatchObject({ year, name: 'alice', plays: 1 });
    const img = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/wrapped/image', headers: t.as(ALICE) });
    expect(img.json().svg).toContain('<svg');
    expect(img.json().fileName).toBe(`alice-${year}.svg`);
    const created = await t.app.inject({ method: 'POST', url: '/api/v1/jellyfin/wrapped/share', headers: t.as(ALICE), payload: { year } });
    expect(created.statusCode).toBe(201);
    const share = created.json();
    // Public: no credentials.
    const page = await t.app.inject({ method: 'GET', url: share.path });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toContain('alice');
    const svg = await t.app.inject({ method: 'GET', url: share.imagePath });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    // Revoked by an admin.
    const del = await t.app.inject({ method: 'DELETE', url: `/api/v1/watchstats/wrapped/shares/${share.id}`, headers: { 'x-api-key': t.adminKey } });
    expect(del.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: share.path })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: share.imagePath })).statusCode).toBe(404);
  });

  it('keeps plugin keys out of the web routes', async () => {
    const t = await build();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/watchstats', headers: t.as(ALICE) })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/settings/watchstats', headers: t.as(ALICE), payload: {} })).statusCode).toBe(403);
  });
});
