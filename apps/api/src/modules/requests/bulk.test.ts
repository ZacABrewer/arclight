import { describe, expect, it } from 'vitest';
import { Permission as P } from '@arclight/shared';
import { addUser, buildApp } from './test-support.js';

async function app() {
  const h = await buildApp();
  h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 }).addMovie({ tmdbId: 604, title: 'Reloaded', year: 2003 });
  const admin = addUser(h.db, { role: 'admin', username: 'boss' });
  const user = addUser(h.db, { username: 'viewer', permissions: P.REQUEST | P.CREATE_ISSUES });
  const other = addUser(h.db, { username: 'other', permissions: P.REQUEST | P.CREATE_ISSUES });
  const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    h.app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
  return { ...h, call, adminCookie: h.cookieFor(admin.id), userCookie: h.cookieFor(user.id), otherCookie: h.cookieFor(other.id) };
}

describe('request and issue bulk routes', () => {
  it('deletes several requests, reporting ids the caller may not touch', async () => {
    const h = await app();
    const mine = (await h.call(h.userCookie, 'POST', '/request', { mediaType: 'movie', tmdbId: 603 })).json().id as number;
    const theirs = (await h.call(h.otherCookie, 'POST', '/request', { mediaType: 'movie', tmdbId: 604 })).json().id as number;

    const res = await h.call(h.userCookie, 'POST', '/request/bulk/delete', { ids: [mine, theirs] });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toEqual([mine]);
    expect(res.json().failed.map((f: { id: number }) => f.id)).toEqual([theirs]);

    const admin = await h.call(h.adminCookie, 'POST', '/request/bulk/delete', { ids: [theirs, 9999] });
    expect(admin.json().ok).toEqual([theirs]);
    expect(admin.json().failed.map((f: { id: number }) => f.id)).toEqual([9999]);
    expect((await h.call(h.adminCookie, 'GET', '/request')).json().pageInfo.total).toBe(0);
  });

  it('retry reports requests that are not failed', async () => {
    const h = await app();
    const id = (await h.call(h.userCookie, 'POST', '/request', { mediaType: 'movie', tmdbId: 603 })).json().id as number;
    const res = await h.call(h.adminCookie, 'POST', '/request/bulk/retry', { ids: [id] });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok.length + res.json().failed.length).toBe(1);
  });

  it('resolves, reopens and deletes several issues', async () => {
    const h = await app();
    const open = async (tmdbId: number) =>
      (await h.call(h.userCookie, 'POST', '/issue', { type: 'video', mediaType: 'movie', tmdbId, message: 'pixelated' })).json().id as number;
    const a = await open(603);
    const b = await open(604);

    const resolved = await h.call(h.adminCookie, 'POST', '/issue/bulk/status', { ids: [a, b], status: 'resolved' });
    expect(resolved.json()).toEqual({ ok: [a, b], failed: [] });
    expect((await h.call(h.adminCookie, 'GET', `/issue/${a}`)).json().status).toBe('resolved');

    const reopened = await h.call(h.adminCookie, 'POST', '/issue/bulk/status', { ids: [b], status: 'open' });
    expect(reopened.json().ok).toEqual([b]);
    expect((await h.call(h.adminCookie, 'GET', `/issue/${b}`)).json().status).toBe('open');

    expect((await h.call(h.adminCookie, 'POST', '/issue/bulk/status', { ids: [a], status: 'closed' })).statusCode).toBe(400);

    const deleted = await h.call(h.adminCookie, 'POST', '/issue/bulk/delete', { ids: [a, b, 4242] });
    expect(deleted.json().ok).toEqual([a, b]);
    expect(deleted.json().failed.map((f: { id: number }) => f.id)).toEqual([4242]);
  });

  it('validates the id list', async () => {
    const h = await app();
    expect((await h.call(h.adminCookie, 'POST', '/request/bulk/delete', { ids: [] })).statusCode).toBe(400);
    expect((await h.call(h.adminCookie, 'POST', '/issue/bulk/delete', { ids: ['x'] })).statusCode).toBe(400);
    expect((await h.call(h.adminCookie, 'POST', '/audiorequest/bulk/explode', { ids: [1] })).statusCode).toBe(400);
  });
});
