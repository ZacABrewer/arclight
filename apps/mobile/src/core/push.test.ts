import { describe, expect, it } from 'vitest';
import { KEYS } from '../config.js';
import type { HttpRequest } from './http.js';
import { memoryStore } from './kv.js';
import { PushError, PushService, memoryScopedStore, type PushDeps } from './push.js';

const RELAY = 'https://arclight-push.moviemethat.com';
const A = 'https://a.example.com';
const NAS = 'http://nas:7878';

function setup(over: Partial<PushDeps> & { responses?: Array<{ status: number; data?: unknown } | Error> } = {}) {
  const calls: HttpRequest[] = [];
  const responses = over.responses ?? [];
  let token = 'tok-1';
  const store = memoryScopedStore();
  const deps: PushDeps = {
    store,
    relayUrl: RELAY + '/',
    platform: 'ios',
    appId: 'com.moviemethat.arclight.admin',
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
  return { svc: new PushService(deps), calls, store, setToken: (t: string) => (token = t) };
}

describe('PushService.register', () => {
  it('registers with the relay and stores the device in the server scope', async () => {
    const { svc, calls, store } = setup({ responses: [{ status: 201, data: { deviceId: 'dev1', secret: 's3cret' } }] });
    const r = await svc.register(A);
    expect(r).toEqual({ relayDeviceId: 'dev1', relaySecret: 's3cret', platform: 'ios', deviceName: 'iPhone', appId: 'com.moviemethat.arclight.admin' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${RELAY}/v1/devices`, data: { token: 'tok-1', platform: 'ios', appId: 'com.moviemethat.arclight.admin', appVersion: '1.0.0', environment: 'sandbox' } });
    expect(JSON.parse(store.data.get(`${A}\npush`)!)).toEqual({ deviceId: 'dev1', secret: 's3cret', token: 'tok-1' });
  });

  it('does not send environment on Android', async () => {
    const { svc, calls } = setup({ platform: 'android', responses: [{ status: 200, data: { deviceId: 'd', secret: 's' } }] });
    await svc.register(A);
    expect(calls[0]!.data).toEqual({ token: 'tok-1', platform: 'android', appId: 'com.moviemethat.arclight.admin', appVersion: '1.0.0' });
  });

  it('gives every server its own device and secret (CLI-16)', async () => {
    const { svc, calls } = setup({ responses: [{ status: 200, data: { deviceId: 'dev1', secret: 's1' } }, { status: 200, data: { deviceId: 'dev2', secret: 's2' } }] });
    const a = await svc.register(A);
    const b = await svc.register(NAS);
    expect([a.relayDeviceId, a.relaySecret]).toEqual(['dev1', 's1']);
    expect([b.relayDeviceId, b.relaySecret]).toEqual(['dev2', 's2']);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
  });

  it('reuses the server’s own device on a second call', async () => {
    const { svc, calls } = setup({ responses: [{ status: 200, data: { deviceId: 'dev1', secret: 's' } }] });
    await svc.register(A);
    expect((await svc.register(A)).relayDeviceId).toBe('dev1');
    expect(calls).toHaveLength(1);
  });

  it('updates a rotated token before reuse, re-registers when the relay forgot the device', async () => {
    const { svc, calls, setToken } = setup({
      responses: [{ status: 200, data: { deviceId: 'dev1', secret: 's' } }, { status: 204 }, { status: 404 }, { status: 200, data: { deviceId: 'dev2', secret: 't' } }],
    });
    await svc.register(A);
    setToken('tok-2');
    await svc.register(A);
    expect(calls[1]).toMatchObject({ method: 'PUT', url: `${RELAY}/v1/devices/dev1`, data: { token: 'tok-2' }, headers: { authorization: 'Bearer s' } });
    setToken('tok-3');
    const r = await svc.register(A);
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
  it('PUTs a new token for the given servers only, ignores an unchanged one', async () => {
    const { svc, calls } = setup({ responses: [{ status: 200, data: { deviceId: 'dev1', secret: 's' } }, { status: 200, data: { deviceId: 'dev2', secret: 't' } }, { status: 204 }] });
    await svc.register(A);
    await svc.register(NAS);
    await svc.onTokenRefresh('tok-1', [A, NAS]);
    expect(calls).toHaveLength(2);
    await svc.onTokenRefresh('tok-9', [A]);
    expect(calls[2]).toMatchObject({ method: 'PUT', url: `${RELAY}/v1/devices/dev1`, data: { token: 'tok-9' } });
    expect(calls).toHaveLength(3);
    expect((await svc.state(A))?.token).toBe('tok-9');
    expect((await svc.state(NAS))?.token).toBe('tok-1');
  });

  it('deletes the server’s own device at the relay', async () => {
    const { svc, calls, store } = setup({ responses: [{ status: 200, data: { deviceId: 'dev1', secret: 's' } }, { status: 204 }] });
    await svc.register(A);
    await svc.unregister(A);
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: `${RELAY}/v1/devices/dev1`, headers: { authorization: 'Bearer s' } });
    expect(store.data.size).toBe(0);
    await svc.unregister(A); // nothing to do
    expect(calls).toHaveLength(2);
  });

  it('clears local state even when the relay is down', async () => {
    const { svc, store } = setup({ responses: [{ status: 200, data: { deviceId: 'dev1', secret: 's' } }, new Error('offline')] });
    await svc.register(A);
    await svc.unregisterAll([A]);
    expect(store.data.size).toBe(0);
  });
});

describe('PushService legacy (pre-0.24 shared device)', () => {
  const legacy = { deviceId: 'old', secret: 'olds', token: 'tok-1', servers: [A, NAS] };

  it('migrates the Preferences registration into each server scope, once', async () => {
    const { svc, store, calls } = setup();
    const prefs = memoryStore({ [KEYS.push]: JSON.stringify(legacy) });
    await svc.migrateLegacy(prefs);
    expect(prefs.data.has(KEYS.push)).toBe(false);
    expect(await svc.state(A)).toEqual({ deviceId: 'old', secret: 'olds', token: 'tok-1', shared: true });
    expect(await svc.state(NAS)).toEqual({ deviceId: 'old', secret: 'olds', token: 'tok-1', shared: true });
    await svc.migrateLegacy(prefs);
    expect(store.data.size).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it('a server turning push on again gets its own device; the shared one goes when unused', async () => {
    const { svc, calls } = setup({ responses: [{ status: 200, data: { deviceId: 'new', secret: 'news' } }, { status: 204 }] });
    await svc.migrateLegacy(memoryStore({ [KEYS.push]: JSON.stringify(legacy) }));
    expect((await svc.register(A)).relayDeviceId).toBe('new');
    await svc.reconcile([A, NAS]);
    expect(calls).toHaveLength(1); // NAS still uses the shared device
    await svc.unregister(NAS); // shared: not deleted from one server's scope
    expect(calls).toHaveLength(1);
    await svc.reconcile([A, NAS]);
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: `${RELAY}/v1/devices/old`, headers: { authorization: 'Bearer olds' } });
    await svc.reconcile([A, NAS]);
    expect(calls).toHaveLength(2);
  });

  it('PUTs a rotated token to the shared device once', async () => {
    const { svc, calls } = setup({ responses: [{ status: 204 }] });
    await svc.migrateLegacy(memoryStore({ [KEYS.push]: JSON.stringify(legacy) }));
    await svc.onTokenRefresh('tok-2', [A, NAS]);
    expect(calls.map((c) => [c.method, c.url])).toEqual([['PUT', `${RELAY}/v1/devices/old`]]);
    expect((await svc.state(NAS))?.token).toBe('tok-2');
  });
});
