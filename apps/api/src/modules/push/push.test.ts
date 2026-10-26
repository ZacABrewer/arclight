import { createCipheriv, createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import type { ServerEvent, User } from '@arclight/shared';
import { Permission } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { issues, mediaRequests, users } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { deliveriesFor, registerPushListener } from './listener.js';
import { pushRoutes } from './routes.js';
import * as pushTables from './schema.js';
import { PushService } from './service.js';
import { b64url, encryptPayload, fromB64url, generateVapidKeys, MAX_PAYLOAD_BYTES, sendWebPush, vapidJwt } from './webpush.js';

const NOW = new Date('2026-10-26T12:00:00Z');

// ---- an independent RFC 8291 implementation (HMAC by hand, no hkdfSync) -------------------

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}
/** HKDF with L <= 32: one Extract and one Expand block. */
function hkdfManual(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

function keysOf(ua: { p256dh: Buffer; auth: Buffer }) {
  return { p256dh: b64url(ua.p256dh), auth: b64url(ua.auth) };
}

/** What the browser does: parse the aes128gcm header and decrypt with its private key. */
function decryptAsUserAgent(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): { plaintext: Buffer; salt: Buffer; rs: number; keyId: Buffer } {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const keyId = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const uaPublic = ua.getPublicKey();
  const secret = ua.computeSecret(keyId);
  const ikm = hkdfManual(authSecret, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, keyId]), 32);
  const cek = hkdfManual(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfManual(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // Strip padding: the last non-zero byte is the delimiter (0x02 for the last record).
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(2);
  return { plaintext: padded.subarray(0, end), salt, rs, keyId };
}

function newUserAgent() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { private: ecdh.getPrivateKey(), p256dh: ecdh.getPublicKey(), auth: Buffer.from('0123456789abcdef') };
}

describe('RFC 8291 encryption', () => {
  it('matches a vector computed independently with fixed keys and salt', () => {
    const ua = newUserAgent();
    const asPrivate = Buffer.alloc(32, 7);
    const salt = Buffer.alloc(16, 9);
    const plaintext = Buffer.from('{"title":"Arclight"}');
    const body = encryptPayload(plaintext, keysOf(ua), { asPrivateKey: asPrivate, salt });

    // Expected body, built step by step from the RFC with HMAC directly.
    const as = createECDH('prime256v1');
    as.setPrivateKey(asPrivate);
    const asPublic = as.getPublicKey();
    const secret = as.computeSecret(ua.p256dh);
    const ikm = hkdfManual(ua.auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua.p256dh, asPublic]), 32);
    const cek = hkdfManual(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdfManual(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
    const c = createCipheriv('aes-128-gcm', cek, nonce);
    const ct = Buffer.concat([c.update(Buffer.concat([plaintext, Buffer.from([2])])), c.final(), c.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(4096);
    const expected = Buffer.concat([salt, rs, Buffer.from([65]), asPublic, ct]);
    expect(body.toString('hex')).toBe(expected.toString('hex'));
  });

  it('reproduces the RFC 8291 appendix A example', () => {
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      {
        p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
      { asPrivateKey: fromB64url('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: fromB64url('DGv6ra1nlYgDCS1FRnbzlw') },
    );
    expect(b64url(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('round-trips through the user agent decryption with a fresh ephemeral key', () => {
    const ua = newUserAgent();
    const message = JSON.stringify({ title: 'Now available', body: 'Dune (2021) is available. ✓', url: '/library/movie/3' });
    const a = encryptPayload(Buffer.from(message), keysOf(ua));
    const b = encryptPayload(Buffer.from(message), keysOf(ua));
    expect(a.equals(b)).toBe(false);
    const out = decryptAsUserAgent(a, ua.private, ua.auth);
    expect(out.plaintext.toString('utf8')).toBe(message);
    expect(out.rs).toBe(4096);
    expect(out.keyId).toHaveLength(65);
    expect(out.keyId[0]).toBe(4);
  });

  it('refuses oversized payloads and malformed subscription keys', () => {
    const ua = newUserAgent();
    expect(() => encryptPayload(Buffer.alloc(MAX_PAYLOAD_BYTES + 1), keysOf(ua))).toThrow(/limit/);
    expect(encryptPayload(Buffer.alloc(MAX_PAYLOAD_BYTES), keysOf(ua)).length).toBe(16 + 4 + 1 + 65 + MAX_PAYLOAD_BYTES + 1 + 16);
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: b64url(Buffer.alloc(65, 1)), auth: b64url(ua.auth) })).toThrow(/P-256/);
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: b64url(ua.p256dh), auth: 'AAAA' })).toThrow(/auth/);
  });
});

describe('VAPID', () => {
  it('generates a P-256 pair and signs an ES256 JWT the public key verifies', () => {
    const keys = generateVapidKeys();
    const pub = fromB64url(keys.publicKey);
    expect(pub).toHaveLength(65);
    expect(fromB64url(keys.privateKey)).toHaveLength(32);
    const jwt = vapidJwt(keys, 'https://fcm.googleapis.com', 'mailto:a@b.c', 1_800_000_000);
    const [h, c, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(fromB64url(h).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(fromB64url(c).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000, sub: 'mailto:a@b.c' });
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64url(s))).toBe(true);
  });

  it('posts the encrypted body with VAPID headers and reports gone subscriptions', async () => {
    const ua = newUserAgent();
    const vapid = generateVapidKeys();
    const seen: Array<{ url: string; headers: Headers; body: Buffer }> = [];
    let status = 201;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers), body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const target = { endpoint: 'https://push.example.com/send/abc', ...keysOf(ua) };
    const ok = await sendWebPush(target, '{"title":"hi"}', { vapid, subject: 'mailto:x@y.z', fetchImpl, now: () => NOW });
    expect(ok).toEqual({ status: 201, ok: true, gone: false });
    const req = seen[0]!;
    expect(req.headers.get('content-encoding')).toBe('aes128gcm');
    expect(req.headers.get('ttl')).toBe('86400');
    expect(req.headers.get('authorization')).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`));
    const claims = JSON.parse(fromB64url(req.headers.get('authorization')!.split('.')[1]!).toString());
    expect(claims.aud).toBe('https://push.example.com');
    expect(decryptAsUserAgent(req.body, ua.private, ua.auth).plaintext.toString()).toBe('{"title":"hi"}');
    status = 410;
    expect(await sendWebPush(target, 'x', { vapid, subject: 'mailto:x@y.z', fetchImpl })).toMatchObject({ ok: false, gone: true });
  });
});

// ---- service / listener / routes --------------------------------------------------------

async function addUser(db: Db, username: string, opts: { role?: 'admin' | 'user'; permissions?: number; settings?: Record<string, unknown> } = {}) {
  return db
    .insert(users)
    .values({
      username,
      usernameKey: username.toLowerCase(),
      passwordHash: 'x',
      role: opts.role ?? 'user',
      permissions: opts.permissions ?? 0,
      settings: opts.settings ?? {},
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .returning()
    .get().id;
}

interface Sent {
  endpoint: string;
  payload: Record<string, unknown>;
}

async function setup() {
  const db = await createTestDb({ ...pushTables });
  const sent: Sent[] = [];
  const browsers = new Map<string, { private: Buffer; auth: Buffer }>();
  const gone = new Set<string>();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (gone.has(url)) return new Response('gone', { status: 410 });
    const ua = browsers.get(url)!;
    const plain = decryptAsUserAgent(Buffer.from(init.body as Uint8Array), ua.private, ua.auth).plaintext.toString();
    sent.push({ endpoint: url, payload: JSON.parse(plain) as Record<string, unknown> });
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  const service = new PushService({ db, fetchImpl, now: () => NOW });
  const subscribe = (userId: number, name: string) => {
    const ua = newUserAgent();
    const endpoint = `https://push.example.com/${name}`;
    browsers.set(endpoint, { private: ua.private, auth: ua.auth });
    return service.subscribe(userId, { endpoint, keys: keysOf(ua) });
  };
  return { db, service, sent, gone, subscribe };
}

/** Lets the listener's fire-and-forget sends settle. */
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('PushService', () => {
  it('generates VAPID keys once and keeps them', async () => {
    const { service } = await setup();
    const key = service.publicKey();
    expect(fromB64url(key)).toHaveLength(65);
    expect(service.publicKey()).toBe(key);
    expect(service.section().subject).toMatch(/^https:/);
  });

  it('upserts subscriptions by endpoint and lists them per user', async () => {
    const { db, service, subscribe } = await setup();
    const alice = await addUser(db, 'alice');
    const bob = await addUser(db, 'bob');
    const first = subscribe(alice, 'phone');
    subscribe(alice, 'laptop');
    expect(service.list(alice).map((s) => s.endpoint)).toEqual(['https://push.example.com/phone', 'https://push.example.com/laptop']);
    // Bob signs in on Alice's phone: the browser re-subscribes and the row moves to him.
    const moved = service.subscribe(bob, { endpoint: first.endpoint, keys: { p256dh: b64url(newUserAgent().p256dh), auth: b64url(Buffer.alloc(16, 1)) }, userAgent: 'Firefox' });
    expect(moved.id).toBe(first.id);
    expect(service.list(alice)).toHaveLength(1);
    expect(service.list(bob)).toEqual([expect.objectContaining({ endpoint: first.endpoint, userAgent: 'Firefox' })]);
  });

  it('only deletes the caller’s own subscription', async () => {
    const { db, service, subscribe } = await setup();
    const alice = await addUser(db, 'alice');
    const bob = await addUser(db, 'bob');
    const sub = subscribe(alice, 'phone');
    expect(service.unsubscribe(bob, sub.endpoint)).toBe(false);
    expect(service.unsubscribe(alice, sub.endpoint)).toBe(true);
    expect(service.list(alice)).toEqual([]);
  });

  it('stores preferences under settings.notifications.push without touching other keys', async () => {
    const { db, service } = await setup();
    const id = await addUser(db, 'alice', { settings: { theme: 'tron', notifications: { discordEnabled: true } } });
    expect(service.preferences(id)).toEqual({ requests: true, availability: true, issues: true });
    service.setPreferences(id, { requests: false, availability: true, issues: false });
    const row = db.select().from(users).all()[0]!;
    expect(row.settings).toEqual({ theme: 'tron', notifications: { discordEnabled: true, push: { requests: false, availability: true, issues: false } } });
    expect(service.preferences(id)).toEqual({ requests: false, availability: true, issues: false });
  });

  it('sends to every browser of a user and drops gone subscriptions', async () => {
    const { db, service, sent, gone, subscribe } = await setup();
    const alice = await addUser(db, 'alice');
    subscribe(alice, 'phone');
    const old = subscribe(alice, 'old');
    gone.add(old.endpoint);
    const result = await service.sendPush(alice, { title: 'Hello', body: 'x'.repeat(2000), url: '/' });
    expect(result).toEqual({ sent: 1, failed: 0, removed: 1 });
    expect(sent[0]!.payload).toMatchObject({ title: 'Hello', url: '/' });
    expect(String(sent[0]!.payload['body']).length).toBeLessThanOrEqual(600);
    expect(service.list(alice).map((s) => s.endpoint)).toEqual(['https://push.example.com/phone']);
  });

  it('notify() respects the per-event preference', async () => {
    const { db, service, sent, subscribe } = await setup();
    const alice = await addUser(db, 'alice', { settings: { notifications: { push: { requests: false, availability: true, issues: true } } } });
    subscribe(alice, 'phone');
    expect(await service.notify(alice, 'requests', { title: 'no' })).toBeNull();
    expect(await service.notify(alice, 'availability', { title: 'yes' })).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(sent.map((s) => s.payload['title'])).toEqual(['yes']);
  });
});

async function addRequest(db: Db, requestedById: number, extra: Partial<typeof mediaRequests.$inferInsert> = {}) {
  return db
    .insert(mediaRequests)
    .values({ type: 'movie', status: 'pending', tmdbId: 438631, title: 'Dune', year: 2021, requestedById, tags: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...extra })
    .returning()
    .get().id;
}

describe('bus listener', () => {
  it('tells managers about a new pending request, but not the requester', async () => {
    const { db, service } = await setup();
    const admin = await addUser(db, 'admin', { role: 'admin' });
    const manager = await addUser(db, 'mgr', { permissions: Permission.MANAGE_REQUESTS });
    const alice = await addUser(db, 'alice');
    const id = await addRequest(db, alice);
    const out = deliveriesFor(db, service, { type: 'request', action: 'created', id });
    expect(out.map((d) => d.userId).sort()).toEqual([admin, manager].sort());
    expect(out[0]).toMatchObject({ kind: 'requests', payload: { title: 'New request', body: 'alice requested Dune (2021).', url: '/requests' } });
  });

  it('pushes approval to the requester through the bus', async () => {
    const { db, service, sent, subscribe } = await setup();
    const alice = await addUser(db, 'alice');
    subscribe(alice, 'phone');
    const id = await addRequest(db, alice, { status: 'approved' });
    const bus = new EventBus();
    registerPushListener({ db, bus, push: service });
    bus.publish({ type: 'request', action: 'approved', id });
    await flush();
    expect(sent).toEqual([{ endpoint: 'https://push.example.com/phone', payload: expect.objectContaining({ title: 'Request approved', body: 'Dune (2021) was approved.' }) }]);
  });

  it('turns an import into one availability push, de-duplicating the completed request', async () => {
    const { db, service, sent, subscribe } = await setup();
    const alice = await addUser(db, 'alice');
    subscribe(alice, 'phone');
    const id = await addRequest(db, alice, { status: 'approved', libraryId: 12 });
    const bus = new EventBus();
    let t = 0;
    registerPushListener({ db, bus, push: service, now: () => t });
    bus.publish({ type: 'import', action: 'imported', title: 'Dune.2021.2160p', mediaType: 'movie', mediaId: 12 });
    bus.publish({ type: 'request', action: 'completed', id });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ title: 'Now available', url: '/library/movie/12', tag: 'available-movie-12' });
    t = 11 * 60_000;
    bus.publish({ type: 'request', action: 'completed', id });
    await flush();
    expect(sent).toHaveLength(2);
  });

  it('skips users who turned the event off and ignores unrelated events', async () => {
    const { db, service, sent, subscribe } = await setup();
    const admin = await addUser(db, 'admin', { role: 'admin', settings: { notifications: { push: { requests: true, availability: true, issues: false } } } });
    const alice = await addUser(db, 'alice');
    subscribe(admin, 'desk');
    const issueId = db
      .insert(issues)
      .values({ type: 'audio', status: 'open', mediaType: 'movie', tmdbId: 1, title: 'Dune', year: 2021, createdById: alice, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
      .returning()
      .get().id;
    expect(deliveriesFor(db, service, { type: 'issue', action: 'created', id: issueId })).toEqual([
      expect.objectContaining({ userId: admin, kind: 'issues', payload: expect.objectContaining({ url: `/issues/${issueId}` }) }),
    ]);
    const bus = new EventBus();
    registerPushListener({ db, bus, push: service });
    bus.publish({ type: 'issue', action: 'created', id: issueId });
    bus.publish({ type: 'queue', action: 'changed' } as ServerEvent);
    await flush();
    expect(sent).toEqual([]);
  });
});

describe('push routes', () => {
  async function app() {
    const env = await setup();
    const alice = await addUser(env.db, 'alice');
    const a = Fastify().withTypeProvider<ZodTypeProvider>();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    a.decorateRequest('auth', null);
    a.addHook('onRequest', async (req) => {
      const id = req.headers['x-user'];
      req.auth = typeof id === 'string' ? { user: { id: Number(id) } as User, via: 'session', isAdmin: false } : { user: null, via: 'apikey', isAdmin: true };
    });
    await a.register(pushRoutes(env.service), { prefix: '/api/v1' });
    return { ...env, app: a, alice };
  }

  it('serves the public key and runs subscription CRUD for the signed-in user', async () => {
    const { app: a, alice, service } = await app();
    const key = await a.inject({ method: 'GET', url: '/api/v1/push/vapid-public-key' });
    expect(key.json()).toEqual({ publicKey: service.publicKey() });
    const ua = newUserAgent();
    const body = { endpoint: 'https://push.example.com/x', expirationTime: null, keys: keysOf(ua) };
    expect((await a.inject({ method: 'POST', url: '/api/v1/push/subscription', payload: body })).json()).toMatchObject({ code: 'NO_USER' });
    const created = await a.inject({ method: 'POST', url: '/api/v1/push/subscription', payload: body, headers: { 'x-user': String(alice), 'user-agent': 'Edge 130' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ endpoint: body.endpoint, userAgent: 'Edge 130' });
    const list = await a.inject({ method: 'GET', url: '/api/v1/push/subscription', headers: { 'x-user': String(alice) } });
    expect(list.json()).toHaveLength(1);
    const del = () => a.inject({ method: 'DELETE', url: '/api/v1/push/subscription', payload: { endpoint: body.endpoint }, headers: { 'x-user': String(alice) } });
    expect((await del()).statusCode).toBe(204);
    expect((await del()).statusCode).toBe(404);
    const bad = await a.inject({ method: 'POST', url: '/api/v1/push/subscription', payload: { endpoint: 'nope', keys: {} }, headers: { 'x-user': String(alice) } });
    expect(bad.statusCode).toBe(400);
  });

  it('reads and writes preferences and sends a test push', async () => {
    const { app: a, alice, subscribe, sent } = await app();
    subscribe(alice, 'phone');
    const h = { 'x-user': String(alice) };
    expect((await a.inject({ method: 'GET', url: '/api/v1/push/preferences', headers: h })).json()).toEqual({ requests: true, availability: true, issues: true });
    const put = await a.inject({ method: 'PUT', url: '/api/v1/push/preferences', headers: h, payload: { requests: false, availability: true, issues: true } });
    expect(put.json()).toEqual({ requests: false, availability: true, issues: true });
    const test = await a.inject({ method: 'POST', url: '/api/v1/push/test', headers: h });
    expect(test.json()).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(sent[0]!.payload).toMatchObject({ title: 'Arclight', url: '/profile' });
  });
});
