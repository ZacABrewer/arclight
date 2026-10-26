import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, buildUrl, ContractError, request } from './client.js';
import { backoffDelay } from './events.js';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('request', () => {
  const Thing = z.object({ id: z.number(), name: z.string() });

  it('parses a successful response with the schema', async () => {
    const fetchFn = mockFetch(200, { id: 1, name: 'x' });
    await expect(request('/thing', Thing)).resolves.toEqual({ id: 1, name: 'x' });
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/thing', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('sends json bodies with a content-type', async () => {
    const fetchFn = mockFetch(200, { id: 1, name: 'x' });
    await request('/thing', Thing, { method: 'POST', json: { name: 'x' } });
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe('{"name":"x"}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('throws ApiError carrying the shared ErrorResponse message and code', async () => {
    mockFetch(409, { error: 'Profile is in use', code: 'PROFILE_IN_USE' });
    const err = await request('/qualityprofile/1', null, { method: 'DELETE' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: 'Profile is in use', code: 'PROFILE_IN_USE' });
  });

  it('throws ContractError when the response drifts from the schema', async () => {
    mockFetch(200, { id: 'one' });
    await expect(request('/thing', Thing)).rejects.toBeInstanceOf(ContractError);
  });

  it('returns undefined for 204 responses', async () => {
    mockFetch(204, undefined);
    await expect(request('/thing/1', null, { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('builds query strings and drops empty values', () => {
    expect(buildUrl('/series', { page: 2, monitored: true, tag: undefined, q: null })).toBe(
      '/api/v1/series?page=2&monitored=true',
    );
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and caps at 30s', () => {
    const mid = () => 0.5; // no jitter
    expect(backoffDelay(1, mid)).toBe(1000);
    expect(backoffDelay(2, mid)).toBe(2000);
    expect(backoffDelay(4, mid)).toBe(8000);
    expect(backoffDelay(20, mid)).toBe(30000);
  });
});
