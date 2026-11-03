import { describe, expect, it } from 'vitest';
import { connect, findHttps } from './probe';
import { fakeFetch } from '../test/fetch';

const arclight = {
  'GET /system/ping': { json: { status: 'ok' } },
  'GET /auth/status': { json: { needsSetup: false, adminExists: true, authenticated: false } },
};

describe('connect', () => {
  it('finds Arclight at a typed address', async () => {
    const { impl } = fakeFetch(arclight);
    const res = await connect(impl, '192.168.1.20:7878');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.url).toMatch(/^https?:\/\/192\.168\.1\.20:7878$/);
      expect(res.needsSetup).toBe(false);
    }
  });

  it('says when the address is not Arclight', async () => {
    const { impl } = fakeFetch({ 'GET /system/ping': { status: 404, json: {} } });
    const res = await connect(impl, 'music.example.com');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not-arclight');
  });

  it('reports an unreachable server', async () => {
    const { impl } = fakeFetch({ 'GET /system/ping': () => new TypeError('Failed to fetch') });
    const res = await connect(impl, '10.0.0.9');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(['unreachable', 'cors']).toContain(res.reason);
  });

  it('rejects input that is not an address', async () => {
    const { impl, calls } = fakeFetch(arclight);
    const res = await connect(impl, 'not an address at all');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid');
    expect(calls).toHaveLength(0);
  });
});

describe('findHttps', () => {
  // Arclight answers only on the addresses in `up`.
  const only = (up: string[]) =>
    fakeFetch({
      'GET /system/ping': (call) => (up.some((u) => call.url.startsWith(`${u}/`)) ? { json: { status: 'ok' } } : new TypeError('Failed to fetch')),
      'GET /auth/status': { json: { needsSetup: false, adminExists: true, authenticated: false } },
    });

  it('finds Arclight over https on the same port', async () => {
    const { impl } = only(['https://music.example.com:7878']);
    expect(await findHttps(impl, 'http://music.example.com:7878')).toBe('https://music.example.com:7878');
  });

  it('finds a reverse proxy on the default port', async () => {
    const { impl } = only(['https://music.example.com']);
    expect(await findHttps(impl, 'http://music.example.com:7878/arclight')).toMatch(/^https:\/\/music\.example\.com(\/arclight)?$/);
  });

  it('gives null when only http answers, and for https addresses', async () => {
    const { impl, calls } = only(['http://music.example.com:7878']);
    expect(await findHttps(impl, 'http://music.example.com:7878')).toBeNull();
    const before = calls.length;
    expect(await findHttps(impl, 'https://music.example.com')).toBeNull();
    expect(calls).toHaveLength(before);
  });
});
