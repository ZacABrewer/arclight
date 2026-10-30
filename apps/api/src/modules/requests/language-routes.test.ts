import { describe, expect, it } from 'vitest';
import { RequestsSettings } from '@arclight/shared';
import { setSection } from '../settings/service.js';
import { MOVIE, SHOW, languageApp } from './language-test-support.js';

type App = Awaited<ReturnType<typeof languageApp>>;

function manualApproval(h: App): void {
  const current = h.services.requests.settings();
  setSection(h.db, 'requests', RequestsSettings.parse({ ...current, autoApproveSubtitleRequests: false, autoApproveAudioRequests: false }), new Date().toISOString());
}

describe('language request routes', () => {
  it('need sign-in and the permission', async () => {
    const h = await languageApp();
    expect((await h.call('GET', '/request/language')).statusCode).toBe(401);
    expect((await h.call('POST', '/request/language', undefined, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'es' })).statusCode).toBe(401);
    const denied = await h.call('POST', '/request/language', h.otherCookie, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'es' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('options and languages are open to portal users', async () => {
    const h = await languageApp();
    const options = await h.call('GET', `/request/language/options?mediaType=series&tmdbId=${SHOW.tmdbId}`, h.userCookie);
    expect(options.statusCode).toBe(200);
    expect(options.json()).toMatchObject({ inLibrary: true, seriesId: h.seriesId, seasons: [{ seasonNumber: 1 }], canRequest: true });
    expect((await h.call('GET', `/request/language/options?mediaType=other&tmdbId=1`, h.userCookie)).statusCode).toBe(400);
    const langs = await h.call('GET', '/request/language/languages', h.otherCookie);
    expect(langs.statusCode).toBe(200);
    expect(langs.json()).toContainEqual({ code: 'es', name: 'Spanish' });
  });

  it('create, duplicate, approve, decline, retry and delete answer with the right codes', async () => {
    const h = await languageApp();
    manualApproval(h);
    const body = { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de', note: 'please' };
    const created = await h.call('POST', '/request/language', h.userCookie, body);
    expect(created.statusCode).toBe(201);
    const id = created.json().id as number;
    expect(created.json()).toMatchObject({ status: 'pending', languageName: 'German', note: 'please' });

    const dup = await h.call('POST', '/request/language', h.userCookie, body);
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'CONFLICT', error: expect.stringMatching(/already requested/) });
    expect((await h.call('POST', '/request/language', h.userCookie, { ...body, language: 'xx-nope' })).statusCode).toBe(400);
    expect((await h.call('POST', '/request/language', h.userCookie, { ...body, note: 'x'.repeat(501) })).statusCode).toBe(400);
    expect((await h.call('POST', '/request/language', h.userCookie, { ...body, seasonNumber: 1 })).statusCode).toBe(400);

    expect((await h.call('GET', `/request/language/${id}`, h.userCookie)).json()).toMatchObject({ id, canRemove: true });
    expect((await h.call('GET', `/request/language/${id}`, h.otherCookie)).statusCode).toBe(403);
    expect((await h.call('GET', '/request/language/999', h.adminCookie)).statusCode).toBe(404);
    expect((await h.call('GET', '/request/language?kind=audio', h.userCookie)).json().pageInfo.total).toBe(1);
    expect((await h.call('GET', '/request/language/count', h.adminCookie)).json()).toEqual({ total: 1, subtitle: 0, audio: 1, pending: 1 });

    expect((await h.call('POST', `/request/language/${id}/approve`, h.userCookie)).statusCode).toBe(403);
    h.fake.outcome = 'grabbed';
    const approved = await h.call('POST', `/request/language/${id}/approve`, h.adminCookie, { mode: 'version' });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'completed', mode: 'version', outcome: 'grabbed' });
    expect((await h.call('POST', `/request/language/${id}/decline`, h.adminCookie, { reason: 'late' })).statusCode).toBe(409);

    const sub = (await h.call('POST', '/request/language', h.userCookie, { kind: 'subtitle', mediaType: 'series', tmdbId: SHOW.tmdbId, language: 'fr' })).json();
    const declined = await h.call('POST', `/request/language/${sub.id}/decline`, h.adminCookie, { reason: 'no' });
    expect(declined.json()).toMatchObject({ status: 'declined', declineReason: 'no' });
    expect((await h.call('POST', `/request/language/${sub.id}/retry`, h.adminCookie)).statusCode).toBe(409);
    expect((await h.call('DELETE', `/request/language/${sub.id}`, h.userCookie)).statusCode).toBe(403);
    expect((await h.call('DELETE', `/request/language/${sub.id}`, h.adminCookie)).statusCode).toBe(204);
  });

  it('bulk actions report per id', async () => {
    const h = await languageApp();
    manualApproval(h);
    const a = (await h.call('POST', '/request/language', h.userCookie, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de' })).json();
    const b = (await h.call('POST', '/request/language', h.userCookie, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'fr' })).json();
    h.fake.error = new Error('nothing found');
    const res = await h.call('POST', '/request/language/bulk/approve', h.adminCookie, { ids: [a.id, 999] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: [], failed: [{ id: a.id, error: 'nothing found' }, { id: 999 }] });
    expect((await h.call('POST', '/request/language/bulk/delete', h.userCookie, { ids: [b.id] })).json()).toEqual({ ok: [b.id], failed: [] });
    expect((await h.call('POST', '/request/language/bulk/other', h.adminCookie, { ids: [a.id] })).statusCode).toBe(400);
  });
});
