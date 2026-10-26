import { describe, expect, it } from 'vitest';
import { VpnError } from './errors.js';
import { GluetunClient } from './gluetun-client.js';
import { fakeFetch, json } from './test-support.js';

async function caught(p: Promise<unknown>): Promise<VpnError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VpnError);
  return err as VpnError;
}

describe('GluetunClient', () => {
  it('sends the API key as X-API-Key and parses the public IP', async () => {
    const f = fakeFetch({
      '/v1/publicip/ip': () => json({ public_ip: '185.1.2.3', country: 'Netherlands', region: 'North Holland', city: 'Amsterdam', hostname: 'x' }),
    });
    const client = new GluetunClient({ controlUrl: 'http://gluetun:8000/', apiKey: 'k3y', fetch: f.fetch });
    await expect(client.publicIp()).resolves.toEqual({ publicIp: '185.1.2.3', country: 'Netherlands', region: 'North Holland', city: 'Amsterdam' });
    expect(f.requests[0]!.url).toBe('http://gluetun:8000/v1/publicip/ip');
    expect(f.requests[0]!.headers.get('x-api-key')).toBe('k3y');
    expect(f.requests[0]!.headers.get('authorization')).toBeNull();
  });

  it('uses basic auth when username and password are set', async () => {
    const f = fakeFetch({ '/v1/vpn/status': () => json({ status: 'running' }) });
    const client = new GluetunClient({ controlUrl: 'http://g:8000', username: 'me', password: 'pw', fetch: f.fetch });
    await expect(client.isRunning()).resolves.toBe(true);
    expect(f.requests[0]!.headers.get('authorization')).toBe(`Basic ${Buffer.from('me:pw').toString('base64')}`);
    expect(f.requests[0]!.headers.get('x-api-key')).toBeNull();
  });

  it('falls back to the legacy openvpn endpoints on 404', async () => {
    const f = fakeFetch({
      '/v1/openvpn/status': () => json({ status: 'stopped' }),
      '/v1/openvpn/portforwarded': () => json({ port: 41234 }),
    });
    const client = new GluetunClient({ controlUrl: 'http://g:8000', fetch: f.fetch });
    await expect(client.isRunning()).resolves.toBe(false);
    await expect(client.forwardedPort()).resolves.toBe(41234);
    expect(f.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/v1/vpn/status',
      '/v1/openvpn/status',
      '/v1/portforward',
      '/v1/openvpn/portforwarded',
    ]);
  });

  it('treats a forwarded port of 0 as none', async () => {
    const f = fakeFetch({ '/v1/portforward': () => json({ port: 0 }) });
    await expect(new GluetunClient({ controlUrl: 'http://g:8000', fetch: f.fetch }).forwardedPort()).resolves.toBeUndefined();
  });

  it('maps 401/403 to unauthorized and 500 to bad-response', async () => {
    const f = fakeFetch({ '/v1/publicip/ip': () => new Response('', { status: 401 }), '/v1/vpn/status': () => new Response('', { status: 500 }) });
    const client = new GluetunClient({ controlUrl: 'http://g:8000', apiKey: 'wrong', fetch: f.fetch });
    expect((await caught(client.publicIp())).code).toBe('unauthorized');
    const err = await caught(client.isRunning());
    expect(err.code).toBe('bad-response');
    expect(err.httpStatus).toBe(500);
  });

  it('maps network failures to unreachable and aborts to timeout', async () => {
    const down = fakeFetch({ '/v1/': () => Promise.reject(new TypeError('fetch failed')) });
    expect((await caught(new GluetunClient({ controlUrl: 'http://g:8000', fetch: down.fetch }).isRunning())).code).toBe('unreachable');
    const slow = fakeFetch({ '/v1/': () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })) });
    expect((await caught(new GluetunClient({ controlUrl: 'http://g:8000', fetch: slow.fetch }).isRunning())).code).toBe('timeout');
  });

  it('rejects malformed bodies as bad-response', async () => {
    const f = fakeFetch({ '/v1/vpn/status': () => new Response('<html>', { status: 200 }), '/v1/portforward': () => json({ port: 'x' }) });
    const client = new GluetunClient({ controlUrl: 'http://g:8000', fetch: f.fetch });
    expect((await caught(client.isRunning())).code).toBe('bad-response');
    expect((await caught(client.forwardedPort())).code).toBe('bad-response');
  });
});
