import { describe, expect, it } from 'vitest';
import { KEYS } from '../config.js';
import type { HttpRequest } from './http.js';
import { memoryStore } from './kv.js';
import { PushError, PushService, type PushDeps } from './push.js';

const RELAY = 'https://arclight-push.moviemethat.com';

function setup(over: Partial<PushDeps> & { responses?: Array<{ status: number; data?: unknown } | Error> } = {}) {
  const calls: HttpRequest[] = [];
  const responses = over.responses ?? [];
  let token = 'tok-1';
  const kv = memoryStore();
  const deps: PushDeps = {
    kv,
    relayUrl: RELAY + '/',
    platform: 'ios',
    appVersion: '1.0.0',
    pushAvailable: async () => true,
    requestPermission: async () => true,
    getToken: async () => token,
    deviceName: async () => 'iPhone',
    environment: async () => 'sandbox',
    http: async (req) => {
      calls.push(req);
      const r = responses.shift() ?? { status: 200, data: {} };
      if (r instanceof Error) throw r;
      return { status: r.status, url: req.url, data: r.data };
    },
    ...over,
  };
  return { svc: new PushService(deps), calls, kv, setToken: (t: string) => (token = t) };
}

describe('PushService.register', () => {
  it('registers with the relay and stores the device', async () => {
    const { svc, calls, kv } = setup({ responses: [{ status: 201, data: { deviceId: 'dev1', secret: 's3cret' } }] });
    const r = await svc.register('https://a.example.com');
    expect(r).toEqual({ relayDeviceId: 'dev1', relaySecret: 's3cret', platform: 'ios', deviceName: 'iPhone' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${RELAY}/v1/devices`, data: { token: 'tok-1', platform: 'ios', appVersion: '1.0.0', environment: 'sandbox' } });
    expect(JSON.parse(kv.data.get(KEYS.push)!)).toEqual({ deviceId: 'dev1', secret: 's3cret', token: 'tok-1', servers: ['https://a.example.com'] });
  });

  it('does not send environment on Android', async () => {
    const { svc, calls } = setup({ platform: 'android', responses: [{ status: 200, data: { deviceId: 'd', secret: 's' } }] });
    await svc.register('https://a.example.com');
    expect(calls[0]!.data).toEqual({ token: 'tok-1', platform: 'android', appVersion: '1.0.0' });
  });

  it('reuses the device for a second server without calling the relay', async () => {
    const { svc, calls } = setup({ responses: [{ status: 200, data: { deviceId: 'dev1', secret: 's' } }] });
    await svc.register('https://a.example.com');
    const r = await svc.register('http://nas:7878');
    expect(r.relayDeviceId).toBe('dev1');
    expect(calls).toHaveLength(1);
    expect((await svc.state())?.servers).toEqual(['https://a.example.com', 'http://nas:7878']);
  });

  it('updates a rotated token before reuse, re-registers when the relay forgot the device', async () => {
    const { svc, calls, setToken } = setup({
      responses: [{ status: 200, data: { deviceId: 'dev1', secret: 's' } }, { status: 204 }, { status: 404 }, { status: 200, data: { deviceId: 'dev2', secret: 't' } }],
    });
    await svc.register('https://a.example.com');
    setToken('tok-2');
    await svc.register('https://a.example.com');
    expect(calls[1]).toMatchObject({ method: 'PUT', url: `${RELAY}/v1/devices/dev1`, data: { token: 'tok-2' }, headers: { authorization: 'Bearer s' } });
    setToken('tok-3');
    const r = await svc.register('https://a.example.com');
    expect(calls[2]).toMatchObject({ method: 'PUT' });
    expect(calls[3]).toMatchObject({ method: 'POST' });
    expect(r.relayDeviceId).toBe('dev2');
  });

  it('rejects with the contract codes', async () => {
    await expect(setup({ pushAvailable: async () => false }).svc.register('x')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(setup({ requestPermission: async () => false }).svc.register('x')).rejects.toMatchObject({ code: 'denied' });
    await expect(setup({ getToken: async () => Promise.reject(new Error('no APNs')) }).svc.register('x')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(setup({ responses: [new Error('offline')] }).svc.register('x')).rejects.toMatchObject({ code: 'relay' });
    await expect(setup({ responses: [{ status: 500, data: {} }] }).svc.register('x')).rejects.toBeInstanceOf(PushError);
  });
});

describe('PushService.onTokenRefresh / unregister', () => {
  it('PUTs a new token, ignores an unchanged one', async () => {
    const { svc, calls } = setup({ responses: [{ status: 200, data: { deviceId: 'dev1', secret: 's' } }, { status: 204 }] });
    await svc.register('https://a.example.com');
    await svc.onTokenRefresh('tok-1');
    expect(calls).toHaveLength(1);
    await svc.onTokenRefresh('tok-9');
    expect(calls[1]).toMatchObject({ method: 'PUT', url: `${RELAY}/v1/devices/dev1`, data: { token: 'tok-9' } });
    expect((await svc.state())?.token).toBe('tok-9');
  });

  it('deletes at the relay only when the last server unregisters', async () => {
    const { svc, calls, kv } = setup({ responses: [{ status: 200, data: { deviceId: 'dev1', secret: 's' } }, { status: 204 }] });
    await svc.register('https://a.example.com');
    await svc.register('http://nas:7878');
    await svc.unregister('https://a.example.com');
    expect(calls).toHaveLength(1);
    await svc.unregister('http://nas:7878');
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: `${RELAY}/v1/devices/dev1`, headers: { authorization: 'Bearer s' } });
    expect(kv.data.has(KEYS.push)).toBe(false);
  });

  it('removes everything with unregister(null), even when the relay is down', async () => {
    const { svc, kv } = setup({ responses: [{ status: 200, data: { deviceId: 'dev1', secret: 's' } }, new Error('offline')] });
    await svc.register('https://a.example.com');
    await svc.register('http://nas:7878');
    await svc.unregister(null);
    expect(kv.data.has(KEYS.push)).toBe(false);
    await svc.unregister(null); // nothing to do
  });
});
