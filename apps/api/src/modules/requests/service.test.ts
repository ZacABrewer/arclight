import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Permission as P, RequestsSettings } from '@media-tron/shared';
import { episodes, movies, rootFolders, seasons, series } from '../../db/schema.js';
import { setSection } from '../settings/service.js';
import { RequestsError } from './errors.js';
import { mediaRequests, overrideRules } from './schema.js';
import { SYSTEM_ACTOR } from './permissions.js';
import { addUser, giveMovieFile, setup, type Harness } from './test-support.js';

const MATRIX = { tmdbId: 603, title: 'The Matrix', year: 1999 };
const SHOW = { tmdbId: 1399, title: 'Thrones', year: 2011, tvdbId: 121361, seasons: [2, 3, 3, 0, 2] }; // S0 specials, S3 has no episodes

async function harness(): Promise<Harness> {
  const h = await setup();
  h.tmdb.addMovie(MATRIX).addSeries(SHOW);
  return h;
}

function settings(h: Harness, patch: Partial<RequestsSettings>): void {
  setSection(h.db, 'requests', RequestsSettings.parse({ ...h.services.requests.settings(), ...patch }));
}

async function created(h: Harness, actor: Parameters<Harness['services']['requests']['create']>[0], input: Parameters<Harness['services']['requests']['create']>[1]) {
  const out = await h.services.requests.create(actor, input);
  if (out.kind !== 'created') throw new Error(`expected created, got ${out.message}`);
  return out.request;
}

async function expectError(promise: Promise<unknown> | (() => unknown), code: RequestsError['code'], message?: RegExp) {
  try {
    if (typeof promise === 'function') await promise();
    else await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(RequestsError);
    expect((err as RequestsError).code).toBe(code);
    if (message) expect((err as RequestsError).message).toMatch(message);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('creating requests', () => {
  it('stores a pending movie request with TMDB facts and notifies request managers', async () => {
    const h = await harness();
    const admin = addUser(h.db, { role: 'admin', settings: { notifications: { discordEnabled: true, discordWebhookUrl: 'https://discord.test/hook' } } });
    const user = addUser(h.db, { permissions: P.REQUEST });
    const req = await created(h, user.actor, { mediaType: 'movie', tmdbId: 603 });
    expect(req).toMatchObject({ status: 'pending', type: 'movie', mediaTitle: 'The Matrix', mediaYear: 1999, mediaStatus: 'pending', canRemove: true });
    expect(req.requestedBy.id).toBe(user.id);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ kind: 'discord', settings: { webhookUrl: 'https://discord.test/hook' } });
    expect(h.sent[0]!.event.type).toBe('requestCreated');
    expect(admin.id).not.toBe(user.id);
  });

  it('refuses users without the request permission and 4K without 4K permission', async () => {
    const h = await harness();
    const nobody = addUser(h.db, { permissions: P.CREATE_ISSUES });
    await expectError(h.services.requests.create(nobody.actor, { mediaType: 'movie', tmdbId: 603 }), 'FORBIDDEN');
    const tvOnly = addUser(h.db, { permissions: P.REQUEST_TV });
    await expectError(h.services.requests.create(tvOnly.actor, { mediaType: 'movie', tmdbId: 603 }), 'FORBIDDEN');
    settings(h, { movie4k: { enabled: true, rootFolderPath: null, qualityProfileId: null, tags: [] } });
    const plain = addUser(h.db, { permissions: P.REQUEST });
    await expectError(h.services.requests.create(plain.actor, { mediaType: 'movie', tmdbId: 603, is4k: true }), 'FORBIDDEN');
  });

  it('refuses 4K requests while 4K is disabled in settings', async () => {
    const h = await harness();
    const u = addUser(h.db, { permissions: P.REQUEST_4K });
    await expectError(h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603, is4k: true }), 'VALIDATION', /disabled/);
  });

  it('rejects a duplicate active movie request and a movie already in the library', async () => {
    const h = await harness();
    const u = addUser(h.db);
    await created(h, u.actor, { mediaType: 'movie', tmdbId: 603 });
    await expectError(h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 }), 'CONFLICT');

    h.tmdb.addMovie({ tmdbId: 10, title: 'Owned', year: 2000 });
    const admin = addUser(h.db, { role: 'admin' });
    const owned = await created(h, admin.actor, { mediaType: 'movie', tmdbId: 10 });
    h.db.update(mediaRequests).set({ status: 'completed' }).where(eq(mediaRequests.id, owned.id)).run();
    await expectError(h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 10 }), 'CONFLICT', /library/);
  });

  it('allows a new request after a decline', async () => {
    const h = await harness();
    const admin = addUser(h.db, { role: 'admin' });
    const u = addUser(h.db);
    const first = await created(h, u.actor, { mediaType: 'movie', tmdbId: 603 });
    await h.services.requests.decline(admin.actor, first.id, 'not now');
    const again = await created(h, u.actor, { mediaType: 'movie', tmdbId: 603 });
    expect(again.status).toBe('pending');
  });

  it('series "all" skips specials and seasons without episodes', async () => {
    const h = await harness();
    const u = addUser(h.db);
    const req = await created(h, u.actor, { mediaType: 'series', tmdbId: 1399, seasons: 'all' });
    expect(req.seasons.map((s) => s.seasonNumber)).toEqual([1, 2, 4]);
    expect(req.mediaTvdbId).toBe(121361);
  });

  it('drops seasons already requested and answers 202 when nothing is left', async () => {
    const h = await harness();
    const u = addUser(h.db);
    await created(h, u.actor, { mediaType: 'series', tmdbId: 1399, seasons: [1, 2] });
    const partial = await created(h, u.actor, { mediaType: 'series', tmdbId: 1399, seasons: [2, 4] });
    expect(partial.seasons.map((s) => s.seasonNumber)).toEqual([4]);
    const none = await h.services.requests.create(u.actor, { mediaType: 'series', tmdbId: 1399, seasons: [1] });
    expect(none).toEqual({ kind: 'accepted', message: 'no seasons available to request' });
  });

  it('expands partial series requests to all seasons when partial requests are disabled', async () => {
    const h = await harness();
    settings(h, { partialRequestsEnabled: false });
    const u = addUser(h.db);
    const req = await created(h, u.actor, { mediaType: 'series', tmdbId: 1399, seasons: [1] });
    expect(req.seasons.map((s) => s.seasonNumber)).toEqual([1, 2, 4]);
  });

  it('auto-approves with an auto-approve permission and sends the movie to the library', async () => {
    const h = await harness();
    const u = addUser(h.db, { permissions: P.REQUEST | P.AUTO_APPROVE_MOVIE });
    const req = await created(h, u.actor, { mediaType: 'movie', tmdbId: 603 });
    expect(req.status).toBe('approved');
    expect(req.modifiedBy?.id).toBe(u.id);
    const movie = h.db.select().from(movies).where(eq(movies.tmdbId, 603)).get();
    expect(movie).toMatchObject({ monitored: true, rootFolderPath: '/media/movies', qualityProfileId: h.profileId });
    expect(req.libraryId).toBe(movie!.id);
    expect(req.mediaStatus).toBe('processing');
    expect(h.searches).toEqual([{ movieId: movie!.id }]);
  });

  it('auto-approves everyone when the global switch is on', async () => {
    const h = await harness();
    settings(h, { autoApprove: { movie: true, series: false, movie4k: false, series4k: false } });
    const u = addUser(h.db);
    expect((await created(h, u.actor, { mediaType: 'movie', tmdbId: 603 })).status).toBe('approved');
    expect((await created(h, u.actor, { mediaType: 'series', tmdbId: 1399, seasons: [1] })).status).toBe('pending');
  });

  it('enforces the movie quota with the spec message', async () => {
    const h = await harness();
    settings(h, { defaultQuotas: { movieLimit: 1, movieDays: 7, tvLimit: null, tvDays: null } });
    h.tmdb.addMovie({ tmdbId: 2, title: 'Two', year: 2002 });
    const u = addUser(h.db);
    await created(h, u.actor, { mediaType: 'movie', tmdbId: 603 });
    await expectError(h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 2 }), 'FORBIDDEN', /Movie Quota exceeded\./);
  });

  it('refuses series requests whose seasons exceed the remaining quota', async () => {
    const h = await harness();
    const u = addUser(h.db, { settings: { quota: { tvLimit: 2, tvDays: 7, movieLimit: null, movieDays: null } } });
    await expectError(h.services.requests.create(u.actor, { mediaType: 'series', tmdbId: 1399, seasons: 'all' }), 'FORBIDDEN', /Series Quota exceeded\./);
    const ok = await created(h, u.actor, { mediaType: 'series', tmdbId: 1399, seasons: [1, 2] });
    expect(ok.seasons).toHaveLength(2);
  });

  it('honours ignoreQuota only for request managers', async () => {
    const h = await harness();
    settings(h, { defaultQuotas: { movieLimit: 1, movieDays: 7, tvLimit: null, tvDays: null } });
    const manager = addUser(h.db, { permissions: P.MANAGE_REQUESTS | P.REQUEST });
    const u = addUser(h.db);
    await expectError(h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603, ignoreQuota: true }), 'FORBIDDEN');
    const req = await created(h, manager.actor, { mediaType: 'movie', tmdbId: 603, userId: u.id, ignoreQuota: true });
    expect(req).toMatchObject({ ignoreQuota: true, requestedBy: { id: u.id } });
  });

  it('only managers may request on behalf of another user', async () => {
    const h = await harness();
    const a = addUser(h.db);
    const b = addUser(h.db);
    await expectError(h.services.requests.create(a.actor, { mediaType: 'movie', tmdbId: 603, userId: b.id }), 'FORBIDDEN');
    const viaKey = await created(h, SYSTEM_ACTOR, { mediaType: 'movie', tmdbId: 603, userId: b.id });
    expect(viaKey.requestedBy.id).toBe(b.id);
  });

  it('refuses titles on the import exclusion list', async () => {
    const h = await harness();
    const { importExclusions } = await import('../../db/schema.js');
    h.db.insert(importExclusions).values({ mediaType: 'movie', tmdbId: 603, title: 'The Matrix' }).run();
    const u = addUser(h.db);
    await expectError(h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 }), 'FORBIDDEN', /exclusion/);
  });
});

describe('override rules', () => {
  function rule(h: Harness, values: Partial<typeof overrideRules.$inferInsert>) {
    const now = new Date().toISOString();
    h.db
      .insert(overrideRules)
      .values({
        name: 'r',
        mediaType: 'series',
        enabled: true,
        users: [],
        genres: [],
        languages: [],
        keywords: [],
        tags: [],
        autoApprove: false,
        createdAt: now,
        updatedAt: now,
        ...values,
      })
      .run();
  }

  it('picks the most specific matching rule (spec example: anime by genre + language)', async () => {
    const h = await harness();
    h.db.insert(rootFolders).values({ path: '/media/anime', mediaType: 'series' }).run();
    h.tmdb.addSeries({ tmdbId: 50, title: 'Anime Show', year: 2020, seasons: [0, 12], genreIds: [16], originalLanguage: 'ja' });
    rule(h, { name: 'B', genres: [16], qualityProfileId: 4 });
    rule(h, { name: 'A', genres: [16], languages: ['ja'], qualityProfileId: 7, rootFolderPath: '/media/anime', tags: [9] });
    const u = addUser(h.db);
    const req = await created(h, u.actor, { mediaType: 'series', tmdbId: 50, seasons: [1] });
    expect(req).toMatchObject({ qualityProfileId: 7, rootFolderPath: '/media/anime', tags: [9] });
  });

  it('skips rules for anime titles unless the rule names the anime keyword, and can auto-approve', async () => {
    const h = await harness();
    h.tmdb.addMovie({ tmdbId: 77, title: 'Anime Film', year: 2021, keywordIds: [210024], genreIds: [16] });
    rule(h, { name: 'generic', mediaType: 'movie', genres: [16], qualityProfileId: 3 });
    const u = addUser(h.db);
    const plain = await created(h, u.actor, { mediaType: 'movie', tmdbId: 77 });
    expect(plain.qualityProfileId).toBeNull();
    h.services.requests.remove(SYSTEM_ACTOR, plain.id);

    rule(h, { name: 'anime', mediaType: 'movie', keywords: [210024], qualityProfileId: h.profileId, autoApprove: true });
    const auto = await created(h, u.actor, { mediaType: 'movie', tmdbId: 77 });
    expect(auto).toMatchObject({ status: 'approved', qualityProfileId: h.profileId });
  });

  it('non-advanced callers cannot set overrides; advanced callers keep theirs over a rule', async () => {
    const h = await harness();
    rule(h, { name: 'all movies', mediaType: 'movie', qualityProfileId: 5, tags: [1] });
    const plain = addUser(h.db);
    const a = await created(h, plain.actor, { mediaType: 'movie', tmdbId: 603, qualityProfileId: 99, tags: [2] });
    expect(a).toMatchObject({ qualityProfileId: 5, tags: [1] });
    h.services.requests.remove(SYSTEM_ACTOR, a.id);
    const adv = addUser(h.db, { permissions: P.REQUEST | P.REQUEST_ADVANCED });
    const b = await created(h, adv.actor, { mediaType: 'movie', tmdbId: 603, qualityProfileId: 99, tags: [2] });
    expect(b.qualityProfileId).toBe(99);
    expect(b.tags.sort()).toEqual([1, 2]);
  });

  it('rules can be restricted to users', async () => {
    const h = await harness();
    const vip = addUser(h.db);
    const other = addUser(h.db);
    rule(h, { name: 'vip', mediaType: 'movie', users: [vip.id], autoApprove: true });
    expect((await created(h, other.actor, { mediaType: 'movie', tmdbId: 603 })).status).toBe('pending');
    h.tmdb.addMovie({ tmdbId: 5, title: 'Five', year: 2005 });
    expect((await created(h, vip.actor, { mediaType: 'movie', tmdbId: 5 })).status).toBe('approved');
  });
});

describe('approval and lifecycle', () => {
  it('approve adds a series monitoring only the requested seasons and searches them', async () => {
    const h = await harness();
    const admin = addUser(h.db, { role: 'admin', settings: {} });
    const u = addUser(h.db, { settings: { notifications: { telegramEnabled: true, telegramChatId: '42' } } });
    const req = await created(h, u.actor, { mediaType: 'series', tmdbId: 1399, seasons: [2] });
    const approved = await h.services.requests.approve(admin.actor, req.id);
    expect(approved.status).toBe('approved');
    expect(approved.seasons).toEqual([{ seasonNumber: 2, status: 'approved' }]);
    const show = h.db.select().from(series).where(eq(series.tmdbId, 1399)).get()!;
    expect(show.monitored).toBe(true);
    const seasonFlags = Object.fromEntries(h.db.select().from(seasons).where(eq(seasons.seriesId, show.id)).all().map((s) => [s.seasonNumber, s.monitored]));
    expect(seasonFlags).toMatchObject({ 0: false, 1: false, 2: true, 4: false });
    const eps = h.db.select().from(episodes).where(eq(episodes.seriesId, show.id)).all();
    expect(eps.filter((e) => e.monitored).every((e) => e.seasonNumber === 2)).toBe(true);
    expect(eps.filter((e) => e.monitored)).toHaveLength(3);
    expect(h.searches).toEqual([{ seriesId: show.id, seasonNumber: 2 }]);
    expect(approved.libraryId).toBe(show.id);
  });

  it('a second approved request for more seasons re-monitors the existing series', async () => {
    const h = await harness();
    const admin = addUser(h.db, { role: 'admin' });
    const u = addUser(h.db);
    await h.services.requests.approve(admin.actor, (await created(h, u.actor, { mediaType: 'series', tmdbId: 1399, seasons: [1] })).id);
    await h.services.requests.approve(admin.actor, (await created(h, u.actor, { mediaType: 'series', tmdbId: 1399, seasons: [4] })).id);
    const show = h.db.select().from(series).where(eq(series.tmdbId, 1399)).get()!;
    const monitored = h.db.select().from(seasons).where(eq(seasons.seriesId, show.id)).all().filter((s) => s.monitored).map((s) => s.seasonNumber);
    expect(monitored.sort()).toEqual([1, 4]);
  });

  it('approve applies approver overrides; only pending requests can be approved', async () => {
    const h = await harness();
    h.db.insert(rootFolders).values({ path: '/media/kids', mediaType: 'movie' }).run();
    const admin = addUser(h.db, { role: 'admin' });
    const u = addUser(h.db);
    const req = await created(h, u.actor, { mediaType: 'movie', tmdbId: 603 });
    const approved = await h.services.requests.approve(admin.actor, req.id, { rootFolderPath: '/media/kids' });
    expect(approved.rootFolderPath).toBe('/media/kids');
    expect(h.db.select().from(movies).get()!.rootFolderPath).toBe('/media/kids');
    await expectError(h.services.requests.approve(admin.actor, req.id), 'CONFLICT');
  });

  it('approval needs MANAGE_REQUESTS and notifies the requester', async () => {
    const h = await harness();
    const u = addUser(h.db, { settings: { notifications: { discordEnabled: true, discordWebhookUrl: 'https://d/u' } } });
    const other = addUser(h.db);
    const req = await created(h, u.actor, { mediaType: 'movie', tmdbId: 603 });
    await expectError(h.services.requests.approve(other.actor, req.id), 'FORBIDDEN');
    const manager = addUser(h.db, { permissions: P.MANAGE_REQUESTS });
    await h.services.requests.approve(manager.actor, req.id);
    const toUser = h.sent.filter((s) => s.settings['webhookUrl'] === 'https://d/u');
    expect(toUser.map((s) => s.event.type)).toEqual(['requestApproved']);
  });

  it('decline records the reason, frees the media status and notifies with requestDeclined', async () => {
    const h = await harness();
    const admin = addUser(h.db, { role: 'admin' });
    const u = addUser(h.db, { settings: { notifications: { discordEnabled: true, discordWebhookUrl: 'https://d/u' } } });
    const req = await created(h, u.actor, { mediaType: 'series', tmdbId: 1399, seasons: [1] });
    const declined = await h.services.requests.decline(admin.actor, req.id, 'already have it elsewhere');
    expect(declined).toMatchObject({ status: 'declined', declineReason: 'already have it elsewhere', mediaStatus: 'unknown' });
    expect(declined.seasons[0]!.status).toBe('declined');
    const evt = h.sent.find((s) => s.event.type === 'requestDeclined');
    expect(evt && 'reason' in evt.event ? evt.event.reason : undefined).toBe('already have it elsewhere');
  });

  it('a failed approval can be retried once the cause is fixed', async () => {
    const h = await harness();
    h.db.delete(rootFolders).run();
    const admin = addUser(h.db, { role: 'admin' });
    const u = addUser(h.db);
    const req = await created(h, u.actor, { mediaType: 'movie', tmdbId: 603 });
    const failed = await h.services.requests.approve(admin.actor, req.id);
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.failureReason).toMatch(/root folder/);
    h.db.insert(rootFolders).values({ path: '/media/movies', mediaType: 'movie' }).run();
    const retried = await h.services.requests.retry(admin.actor, req.id);
    expect(retried.status).toBe('approved');
    expect(retried.libraryId).not.toBeNull();
    await expectError(h.services.requests.retry(admin.actor, req.id), 'CONFLICT');
  });

  it('owners may delete their pending requests only; managers any', async () => {
    const h = await harness();
    const admin = addUser(h.db, { role: 'admin' });
    const u = addUser(h.db);
    const other = addUser(h.db);
    const req = await created(h, u.actor, { mediaType: 'movie', tmdbId: 603 });
    expect(() => h.services.requests.remove(other.actor, req.id)).toThrow(RequestsError);
    await h.services.requests.approve(admin.actor, req.id);
    expect(() => h.services.requests.remove(u.actor, req.id)).toThrow(/pending/);
    h.services.requests.remove(admin.actor, req.id);
    expect(h.db.select().from(mediaRequests).all()).toHaveLength(0);
  });

  it('owners can change the seasons of a pending series request', async () => {
    const h = await harness();
    const u = addUser(h.db);
    const req = await created(h, u.actor, { mediaType: 'series', tmdbId: 1399, seasons: [1] });
    const updated = await h.services.requests.update(u.actor, req.id, { seasons: [1, 2] });
    expect(updated.seasons.map((s) => s.seasonNumber)).toEqual([1, 2]);
    await expectError(h.services.requests.update(u.actor, req.id, { qualityProfileId: 3 }), 'FORBIDDEN');
  });

  it('bulk approve reports per-request outcomes', async () => {
    const h = await harness();
    h.tmdb.addMovie({ tmdbId: 2, title: 'Two', year: 2002 });
    const admin = addUser(h.db, { role: 'admin' });
    const u = addUser(h.db);
    const a = await created(h, u.actor, { mediaType: 'movie', tmdbId: 603 });
    const b = await created(h, u.actor, { mediaType: 'movie', tmdbId: 2 });
    const res = await h.services.requests.bulk(admin.actor, [a.id, b.id, 999], 'approve');
    expect(res.ok.sort()).toEqual([a.id, b.id].sort());
    expect(res.failed).toEqual([{ id: 999, error: 'request 999 not found' }]);
  });
});

describe('listing and counting', () => {
  it('scopes lists to the caller unless they may view all, and filters by status', async () => {
    const h = await harness();
    h.tmdb.addMovie({ tmdbId: 2, title: 'Two', year: 2002 });
    const admin = addUser(h.db, { role: 'admin' });
    const a = addUser(h.db);
    const b = addUser(h.db);
    const viewer = addUser(h.db, { permissions: P.REQUEST_VIEW });
    const ra = await created(h, a.actor, { mediaType: 'movie', tmdbId: 603 });
    await created(h, b.actor, { mediaType: 'movie', tmdbId: 2 });
    await h.services.requests.approve(admin.actor, ra.id);

    expect(h.services.requests.list(a.actor, {}).results.map((r) => r.id)).toEqual([ra.id]);
    expect(() => h.services.requests.list(a.actor, { requestedBy: b.id })).toThrow(RequestsError);
    expect(h.services.requests.list(viewer.actor, {}).pageInfo.total).toBe(2);
    expect(h.services.requests.list(admin.actor, { filter: 'pending' }).results.map((r) => r.requestedBy.id)).toEqual([b.id]);
    expect(h.services.requests.list(admin.actor, { filter: 'processing' }).results.map((r) => r.id)).toEqual([ra.id]);
    expect(() => h.services.requests.get(b.actor, ra.id)).toThrow(RequestsError);

    const count = h.services.requests.count(admin.actor);
    expect(count).toMatchObject({ total: 2, movie: 2, pending: 1, approved: 1, processing: 1, available: 0 });
    giveMovieFile(h.db, 603);
    expect(h.services.requests.count(admin.actor).available).toBe(1);
  });
});
