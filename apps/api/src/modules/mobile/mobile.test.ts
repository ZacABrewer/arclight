import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_RELAY_URL, type User } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { mediaRequests, mobileDevices, users } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { maskSecrets } from '../config-export/secrets.js';
import { registerPushListener } from '../push/listener.js';
import { PushService } from '../push/service.js';
import { mobileEnv } from './index.js';
import { parseRetryAfter, RelayClient } from './relay.js';
import { mobileRoutes } from './routes.js';
import { MobileService, type MobileServiceOptions } from './service.js';

const NOW = new Date('2026-10-31T12:00:00Z');
const SECRET = 'relay-secret-0123456789abcdef';

// ---- a fake push relay (real HTTP on 127.0.0.1) -------------------------------------------

interface RelayCall {
  auth: string | undefined;
  body: Record<string, unknown>;
}

interface FakeRelay {
  url: string;
  calls: RelayCall[];
  /** Answer for the next calls (status, optional headers); default 200 {ok:true}. */
  respond: (req: RelayCall) => { status: number; headers?: Record<string, string>; delayMs?: number };
  close: () => Promise<void>;
}

const servers: Server[] = [];
const services: MobileService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) s.dispose();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function fakeRelay(): Promise<FakeRelay> {
  const relay: FakeRelay = { url: '', calls: [], respond: () => ({ status: 200 }), close: async () => undefined };
  const server = createServer((req, res) => {
    void (async () => {
      const text = await readBody(req);
      if (req.method !== 'POST' || req.url !== '/v1/send') {
        res.writeHead(404).end();
        return;
      }
      const call: RelayCall = { auth: req.headers.authorization, body: JSON.parse(text) as Record<string, unknown> };
      relay.calls.push(call);
      const answer = relay.respond(call);
      const send = () => {
        res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
        res.end(JSON.stringify(answer.status === 200 ? { ok: true } : { ok: false }));
      };
      if (answer.delayMs) setTimeout(send, answer.delayMs);
      else send();
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  servers.push(server);
  relay.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return relay;
}

// ---- fixtures ------------------------------------------------------------------------------

async function addUser(db: Db, username: string, opts: { role?: 'admin' | 'user'; settings?: Record<string, unknown> } = {}) {
  return db
    .insert(users)
    .values({ username, usernameKey: username, passwordHash: 'x', role: opts.role ?? 'user', settings: opts.settings ?? {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
    .returning()
    .get().id;
}

async function setup(over: Partial<MobileServiceOptions> = {}) {
  const db = await createTestDb();
  const relay = await fakeRelay();
  let serverUrl: string | undefined = 'https://arclight.example.com/';
  const mobile = new MobileService({ db, relayUrl: relay.url, enabled: true, serverUrl: () => serverUrl, baseBackoffMs: 60, ...over });
  services.push(mobile);
  const push = new PushService({ db, now: () => NOW });
  push.addSink(mobile);
  const register = (userId: number, n = 1) =>
    mobile.register(userId, { relayDeviceId: `dev-${userId}-${n}`, relaySecret: `${SECRET}-${userId}-${n}`, platform: 'ios', deviceName: `Phone ${n}`, appVersion: '1.0.0' });
  return { db, relay, mobile, push, register, setServerUrl: (v: string | undefined) => (serverUrl = v) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls until `check` passes (fire-and-forget deliveries). */
async function eventually(check: () => void, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > end) throw err;
      await wait(10);
    }
  }
}

// ---- tests ---------------------------------------------------------------------------------

describe('mobile env', () => {
  it('defaults to the public relay and turns off with ARCLIGHT_PUSH_RELAY=off', () => {
    expect(mobileEnv({})).toEqual({ relayUrl: DEFAULT_PUSH_RELAY_URL, enabled: true });
    expect(mobileEnv({ ARCLIGHT_PUSH_RELAY_URL: ' https://relay.example.com ', ARCLIGHT_PUSH_RELAY: 'on' })).toEqual({ relayUrl: 'https://relay.example.com', enabled: true });
    expect(mobileEnv({ ARCLIGHT_PUSH_RELAY: 'OFF' }).enabled).toBe(false);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter(new Date(1_000_000 + 3000).toUTCString(), 1_000_000)).toBeLessThanOrEqual(3000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('MobileService devices', () => {
  it('upserts by relay device id, rebinding the device to whoever registered last', async () => {
    const { db, mobile, register } = await setup();
    const alice = await addUser(db, 'alice');
    const bob = await addUser(db, 'bob');
    const first = register(alice);
    const again = mobile.register(bob, { relayDeviceId: first.relayDeviceId, relaySecret: 'another-secret-0123456789', platform: 'android', deviceName: 'Pixel' });
    expect(again.id).toBe(first.id);
    expect(mobile.list(alice)).toEqual([]);
    expect(mobile.list(bob)).toEqual([expect.objectContaining({ platform: 'android', deviceName: 'Pixel', userId: bob })]);
    expect(db.select().from(mobileDevices).get()?.relaySecret).toBe('another-secret-0123456789');
  });

  it('removes devices with their user (cascade)', async () => {
    const { db, register } = await setup();
    const alice = await addUser(db, 'alice');
    register(alice);
    db.delete(users).run();
    expect(db.select().from(mobileDevices).all()).toEqual([]);
  });

  it('masks the relay secret in audit details', () => {
    expect(maskSecrets({ relayDeviceId: 'd', relaySecret: SECRET })).toEqual({ relayDeviceId: 'd', relaySecret: '********' });
  });
});

describe('mobile delivery', () => {
  it('sends a notification to the user’s phones through the relay with deep link and server URL', async () => {
    const { db, relay, push, register } = await setup();
    const alice = await addUser(db, 'alice');
    register(alice);
    const id = db
      .insert(mediaRequests)
      .values({ type: 'movie', status: 'approved', tmdbId: 438631, title: 'Dune', year: 2021, requestedById: alice, tags: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
      .returning()
      .get().id;
    const bus = new EventBus();
    registerPushListener({ db, bus, push });
    bus.publish({ type: 'request', action: 'approved', id });
    await eventually(() => expect(relay.calls).toHaveLength(1));
    expect(relay.calls[0]).toEqual({
      auth: `Bearer ${SECRET}-${alice}-1`,
      body: {
        deviceId: `dev-${alice}-1`,
        title: 'Request approved',
        body: 'Dune (2021) was approved.',
        data: { url: '/requests/mine', server: 'https://arclight.example.com', channel: 'requests' },
        threadId: `request-${id}`,
      },
    });
  });

  it('respects the user’s push preferences and omits data.server without an Application URL', async () => {
    const { db, relay, push, register, setServerUrl } = await setup();
    const alice = await addUser(db, 'alice', { settings: { notifications: { push: { requests: false, availability: true, issues: true } } } });
    register(alice);
    setServerUrl('');
    expect(await push.notify(alice, 'requests', { title: 'no' })).toBeNull();
    await push.notify(alice, 'availability', { title: 'Now available', body: 'Dune is available.', url: '/library/movie/3' });
    await eventually(() => expect(relay.calls).toHaveLength(1));
    expect(relay.calls[0]!.body).toEqual({ deviceId: `dev-${alice}-1`, title: 'Now available', body: 'Dune is available.', data: { url: '/library/movie/3', channel: 'general' } });
  });

  it('deletes a device the relay reports gone (410 and 404)', async () => {
    const { db, relay, mobile, register } = await setup();
    const alice = await addUser(db, 'alice');
    const gone = register(alice, 1);
    const unknown = register(alice, 2);
    register(alice, 3);
    relay.respond = (c) => ({ status: c.body['deviceId'] === gone.relayDeviceId ? 410 : c.body['deviceId'] === unknown.relayDeviceId ? 404 : 200 });
    expect(await mobile.deliver(alice, { title: 'hi' })).toEqual({ sent: 1, removed: 2, failed: 0, deferred: 0 });
    expect(mobile.list(alice).map((d) => d.relayDeviceId)).toEqual([`dev-${alice}-3`]);
  });

  it('backs off after 429 and retries each send once, without a storm', async () => {
    const { db, relay, mobile, register } = await setup({ baseBackoffMs: 400 });
    const alice = await addUser(db, 'alice');
    const device = register(alice);
    relay.respond = () => ({ status: 429 });
    expect(await mobile.deliver(alice, { title: 'one' })).toEqual({ sent: 0, removed: 0, failed: 0, deferred: 1 });
    // While paused, a new notification does not reach the relay; it waits for the same moment.
    expect(await mobile.deliver(alice, { title: 'two' })).toEqual({ sent: 0, removed: 0, failed: 0, deferred: 1 });
    expect(relay.calls).toHaveLength(1);
    expect(mobile.list(alice)[0]!.lastError).toMatch(/rate limited/);
    // Each send is retried once after the pause; still 429, so they are dropped.
    await eventually(() => expect(relay.calls).toHaveLength(3));
    await wait(600);
    expect(relay.calls).toHaveLength(3);
    expect(mobile.pendingRetries).toBe(0);
    expect(mobile.list(alice).map((d) => d.id)).toEqual([device.id]);
  });

  it('delivers on the retry once the relay recovers and clears the last error', async () => {
    const { db, relay, mobile, register } = await setup({ baseBackoffMs: 40 });
    const alice = await addUser(db, 'alice');
    register(alice);
    let first = true;
    relay.respond = () => {
      const status = first ? 503 : 200;
      first = false;
      return { status, headers: status === 503 ? { 'retry-after': '0' } : {} };
    };
    expect((await mobile.deliver(alice, { title: 'later' })).deferred).toBe(1);
    await eventually(() => expect(relay.calls).toHaveLength(2));
    await eventually(() => expect(mobile.list(alice)[0]!.lastError).toBeUndefined());
    expect(relay.calls[1]!.body['title']).toBe('later');
  });

  it('times out a hanging relay instead of waiting forever', async () => {
    const relay = await fakeRelay();
    relay.respond = () => ({ status: 200, delayMs: 500 });
    const client = new RelayClient({ baseUrl: relay.url, timeoutMs: 50 });
    expect(await client.send(SECRET, { deviceId: 'd', title: 't', body: '' })).toEqual({ kind: 'retry', message: 'push relay timed out' });
  });

  it('sends nothing when mobile push is disabled', async () => {
    const { db, relay, push, mobile, register } = await setup({ enabled: false });
    const alice = await addUser(db, 'alice');
    const d = register(alice);
    await push.notify(alice, 'requests', { title: 'x' });
    expect(await mobile.deliver(alice, { title: 'x' })).toEqual({ sent: 0, removed: 0, failed: 0, deferred: 0 });
    expect(await mobile.test(alice, false, d.id)).toMatchObject({ ok: false, outcome: 'disabled' });
    await wait(30);
    expect(relay.calls).toEqual([]);
  });

  it('never blocks notify() on a slow relay', async () => {
    const { db, relay, push, register } = await setup({ timeoutMs: 5000 });
    const alice = await addUser(db, 'alice');
    register(alice);
    relay.respond = () => ({ status: 200, delayMs: 1500 });
    const started = Date.now();
    await push.notify(alice, 'requests', { title: 'slow' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('mobile routes', () => {
  async function app(over: Partial<MobileServiceOptions> = {}) {
    const env = await setup(over);
    const alice = await addUser(env.db, 'alice');
    const bob = await addUser(env.db, 'bob');
    const admin = await addUser(env.db, 'root', { role: 'admin' });
    const a = Fastify().withTypeProvider<ZodTypeProvider>();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    a.decorateRequest('auth', null);
    a.addHook('onRequest', async (req) => {
      const id = req.headers['x-user'];
      const isAdmin = req.headers['x-admin'] === '1';
      req.auth = typeof id === 'string' ? { user: { id: Number(id) } as User, via: 'session', isAdmin, appAccess: [] } : { user: null, via: 'apikey', isAdmin: true, appAccess: [] };
    });
    await a.register(mobileRoutes(env.mobile), { prefix: '/api/v1' });
    return { ...env, app: a, alice, bob, admin };
  }

  const body = (n: string) => ({ relayDeviceId: `relay-${n}`, relaySecret: `${SECRET}-${n}`, platform: 'ios', deviceName: `iPhone ${n}`, appVersion: '1.2.0' });

  it('registers, lists and deletes the caller’s own devices without ever returning the secret', async () => {
    const { app: a, alice, bob } = await app();
    const h = { 'x-user': String(alice) };
    const created = await a.inject({ method: 'POST', url: '/api/v1/mobile/devices', headers: h, payload: body('a') });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ userId: alice, relayDeviceId: 'relay-a', platform: 'ios', deviceName: 'iPhone a', appVersion: '1.2.0' });
    expect(created.body).not.toContain(SECRET);
    const list = await a.inject({ method: 'GET', url: '/api/v1/mobile/devices', headers: h });
    expect(list.json()).toHaveLength(1);
    expect(list.body).not.toContain('relaySecret');
    // Bob can neither see nor delete Alice's device.
    expect((await a.inject({ method: 'GET', url: '/api/v1/mobile/devices', headers: { 'x-user': String(bob) } })).json()).toEqual([]);
    const id = created.json().id as number;
    expect((await a.inject({ method: 'DELETE', url: `/api/v1/mobile/devices/${id}`, headers: { 'x-user': String(bob) } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: `/api/v1/mobile/devices/${id}/test`, headers: { 'x-user': String(bob) } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'DELETE', url: `/api/v1/mobile/devices/${id}`, headers: h })).statusCode).toBe(204);
    expect((await a.inject({ method: 'DELETE', url: `/api/v1/mobile/devices/${id}`, headers: h })).statusCode).toBe(404);
  });

  it('validates the body and needs a signed-in user to register', async () => {
    const { app: a, alice } = await app();
    expect((await a.inject({ method: 'POST', url: '/api/v1/mobile/devices', payload: body('k') })).json()).toMatchObject({ code: 'NO_USER' });
    const bad = await a.inject({ method: 'POST', url: '/api/v1/mobile/devices', headers: { 'x-user': String(alice) }, payload: { ...body('x'), platform: 'windows' } });
    expect(bad.statusCode).toBe(400);
  });

  it('lets admins list every device with its owner and remove any', async () => {
    const { app: a, alice, bob, admin } = await app();
    await a.inject({ method: 'POST', url: '/api/v1/mobile/devices', headers: { 'x-user': String(alice) }, payload: body('a') });
    await a.inject({ method: 'POST', url: '/api/v1/mobile/devices', headers: { 'x-user': String(bob) }, payload: body('b') });
    expect((await a.inject({ method: 'GET', url: '/api/v1/mobile/devices?all=true', headers: { 'x-user': String(alice) } })).statusCode).toBe(403);
    const ah = { 'x-user': String(admin), 'x-admin': '1' };
    const all = await a.inject({ method: 'GET', url: '/api/v1/mobile/devices?all=true', headers: ah });
    expect(all.json().map((d: { userName: string }) => d.userName)).toEqual(['alice', 'bob']);
    expect(all.body).not.toContain(SECRET);
    expect((await a.inject({ method: 'GET', url: '/api/v1/mobile/devices', headers: ah })).json()).toEqual([]);
    const bobs = all.json()[1].id as number;
    expect((await a.inject({ method: 'DELETE', url: `/api/v1/mobile/devices/${bobs}`, headers: ah })).statusCode).toBe(204);
  });

  it('sends a rate-limited test notification and reports gone devices', async () => {
    const { app: a, alice, relay } = await app();
    const h = { 'x-user': String(alice) };
    const id = (await a.inject({ method: 'POST', url: '/api/v1/mobile/devices', headers: h, payload: body('a') })).json().id as number;
    const test = await a.inject({ method: 'POST', url: `/api/v1/mobile/devices/${id}/test`, headers: h });
    expect(test.json()).toEqual({ ok: true, outcome: 'sent' });
    expect(relay.calls[0]).toMatchObject({ auth: `Bearer ${SECRET}-a`, body: { deviceId: 'relay-a', title: 'Arclight', data: { url: '/profile', server: 'https://arclight.example.com' } } });
    const again = await a.inject({ method: 'POST', url: `/api/v1/mobile/devices/${id}/test`, headers: h });
    expect(again.statusCode).toBe(429);
    expect(relay.calls).toHaveLength(1);

    const id2 = (await a.inject({ method: 'POST', url: '/api/v1/mobile/devices', headers: h, payload: body('b') })).json().id as number;
    relay.respond = () => ({ status: 410 });
    expect((await a.inject({ method: 'POST', url: `/api/v1/mobile/devices/${id2}/test`, headers: h })).json()).toMatchObject({ ok: false, outcome: 'removed' });
    expect((await a.inject({ method: 'GET', url: '/api/v1/mobile/devices', headers: h })).json().map((d: { id: number }) => d.id)).toEqual([id]);
  });

  it('serves pairing info: Application URL when set, push on/off', async () => {
    const { app: a, alice, setServerUrl } = await app();
    const h = { 'x-user': String(alice) };
    expect((await a.inject({ method: 'GET', url: '/api/v1/mobile/pairing', headers: h })).json()).toEqual({ serverUrl: 'https://arclight.example.com', pushEnabled: true });
    setServerUrl('not a url');
    expect((await a.inject({ method: 'GET', url: '/api/v1/mobile/pairing', headers: h })).json()).toEqual({ serverUrl: null, pushEnabled: true });
  });
});
