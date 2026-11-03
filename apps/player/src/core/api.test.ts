import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, buildApiUrl, isNetworkError, request, resetArtworkLink, rewriteArtwork, setFetch, setUnauthorizedHandler } from './api';
import { setSession } from './session';
import { fakeFetch } from '../test/fetch';

const SERVER = 'https://music.example.com/arclight';

beforeEach(() => {
  resetArtworkLink();
  setSession({ accountId: 'a_1', serverUrl: SERVER, token: 'alt_token', deviceId: 3 });
});

afterEach(() => {
  setFetch(null);
  setSession(null);
  setUnauthorizedHandler(null);
});

describe('request', () => {
  it('sends the device token to the account server, without cookies', async () => {
    const { impl, calls } = fakeFetch({ 'GET /user/me': { json: { ok: true } } });
    setFetch(impl);
    await request('/user/me', z.object({ ok: z.boolean() }));
    expect(calls[0]!.url).toBe(`${SERVER}/api/v1/user/me`);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer alt_token');
    expect((impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].credentials).toBe('omit');
  });

  it('builds query strings and skips empty values', () => {
    expect(buildApiUrl(`${SERVER}/`, '/x', { a: 1, b: undefined, c: 'd e' })).toBe(`${SERVER}/api/v1/x?a=1&c=d+e`);
  });

  it('maps error envelopes to ApiError with the code', async () => {
    setFetch(fakeFetch({ 'POST /app/sign-in': { status: 401, json: { error: 'Two-factor code needed', code: 'TOTP_REQUIRED' } } }).impl);
    const err = await request('/app/sign-in', null, { method: 'POST', json: {}, target: { serverUrl: SERVER, token: null } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).code).toBe('TOTP_REQUIRED');
  });

  it('turns a failed fetch into a network error', async () => {
    setFetch(fakeFetch({ 'GET /x': () => new TypeError('Failed to fetch') }).impl);
    const err = await request('/x', null).catch((e: unknown) => e);
    expect(isNetworkError(err)).toBe(true);
  });

  it('calls the sign-out handler on a 401 for the active account only', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    setFetch(fakeFetch({ 'GET /x': { status: 401, json: { error: 'no', code: 'UNAUTHORIZED' } } }).impl);
    await request('/x', null).catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    await request('/x', null, { target: { serverUrl: SERVER, token: 'other' } }).catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps the device signed in when a profile PIN is wrong', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    setFetch(fakeFetch({ 'POST /households/profiles/3/select': { status: 401, json: { error: 'Wrong PIN', code: 'pin-wrong' } } }).impl);
    const err = await request('/households/profiles/3/select', null, { method: 'POST', json: { pin: '0000' } }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('pin-wrong');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('artwork', () => {
  it('makes artwork paths absolute and signed', async () => {
    const { impl, calls } = fakeFetch({
      'GET /playback/items/x': { json: { title: 'A', artworkUrl: '/arclight/api/v1/playback/artwork/album/12', other: '/not/artwork' } },
      'POST /playback/artwork-link': { json: { query: 'u=1&exp=99&sig=abc', expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString() } },
    });
    setFetch(impl);
    const schema = z.object({ title: z.string(), artworkUrl: z.string(), other: z.string() });
    const res = await request('/playback/items/x', schema);
    expect(res.artworkUrl).toBe('https://music.example.com/arclight/api/v1/playback/artwork/album/12?u=1&exp=99&sig=abc');
    expect(res.other).toBe('/not/artwork');
    // The signed query is reused.
    await request('/playback/items/x', schema);
    expect(calls.filter((c) => c.url.endsWith('/playback/artwork-link'))).toHaveLength(1);
  });

  it('rewrites nested values and leaves the rest alone', () => {
    const out = rewriteArtwork({ list: [{ art: '/api/v1/playback/artwork/book/3' }], n: 1 }, 'http://10.0.0.2:7878', null);
    expect(out).toEqual({ list: [{ art: 'http://10.0.0.2:7878/api/v1/playback/artwork/book/3' }], n: 1 });
  });
});
