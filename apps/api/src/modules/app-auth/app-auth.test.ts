import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_DEVICE_CODE_TTL_MS, APP_PAIR_CODE_ALPHABET, APP_PAIR_CODE_TTL_MS, parseAppPairingUri } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor, SESSION_COOKIE } from '../auth/index.js';
import { totpCode } from '../auth/totp.js';
import { setSection } from '../settings/service.js';
import { appAuthServiceFor, APP_DEVICE_TOUCH_MS, PAIR_CODES_PER_WINDOW } from './index.js';
import { APP_DEVICE_IDLE_MS, MAX_PENDING_DEVICE_CODES } from './service.js';

// The Arclight player app's sign-in over HTTP: password sign-in (with two-factor), QR pairing,
// the Bearer token on portal and player routes, device management, revocation and CORS for the
// app's WebView origins.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };
const DEVICE = { deviceName: 'Test Phone', platform: 'android', appVersion: '1.0.0' } as const;

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
  clock: { t: number };
}
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.app.close();
});

async function harness(): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  const clock = { t: Date.now() };
  let ctx: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (c) => {
      ctx = c;
      appAuthServiceFor(c, { now: () => clock.t });
    },
  });
  await app.ready();
  setSection(db, 'player', { enabled: true });
  const h = { app, ctx: ctx!, db, clock };
  open.push(h);
  return h;
}

let n = 0;
async function makeUser(h: Harness, opts: { player?: boolean; role?: 'user' | 'admin' } = {}) {
  const auth = authServiceFor(h.ctx);
  const username = `appuser${++n}`;
  const user = await auth.createUser({ username, password: 'password1', role: opts.role ?? 'user', ...(opts.player === undefined ? {} : { settings: { player: { allowed: opts.player } } }) });
  return { id: user.id, username, cookie: `${SESSION_COOKIE}=${auth.createSession(user.id).token}` };
}

const post = (h: Harness, url: string, payload: object | undefined, headers: Record<string, string> = {}, remoteAddress?: string) =>
  h.app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload }), ...(remoteAddress ? { remoteAddress } : {}) });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function signInApp(h: Harness, username: string, extra: object = {}) {
  return post(h, '/api/v1/app/sign-in', { username, password: 'password1', ...DEVICE, ...extra });
}

describe('password sign-in', () => {
  it('issues a device token for a player user; the hash is stored, never the token', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    const res = await signInApp(h, u.username);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toMatch(/^alt_[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({ user: { id: u.id, username: u.username }, server: { name: 'Arclight' } });
    expect(typeof body.server.version).toBe('string');
    const rows = h.db.select().from(schema.appDevices).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.deviceId, userId: u.id, name: 'Test Phone', platform: 'android', appVersion: '1.0.0', method: 'password' });
    expect(rows[0]!.tokenHash).not.toContain(body.token);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a wrong password, an unknown user and accounts without player access', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    expect((await signInApp(h, u.username, { password: 'nope-nope' })).json().code).toBe('INVALID_CREDENTIALS');
    expect((await signInApp(h, 'nobody')).statusCode).toBe(401);
    const denied = await makeUser(h);
    const res = await signInApp(h, denied.username);
    expect([res.statusCode, res.json().code]).toEqual([403, 'PLAYER_NOT_ALLOWED']);
    setSection(h.db, 'player', { enabled: false });
    expect((await signInApp(h, u.username)).json().code).toBe('PLAYER_DISABLED');
    expect(h.db.select().from(schema.appDevices).all()).toHaveLength(0);
  });

  it('validates the device fields', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    expect((await signInApp(h, u.username, { platform: 'windows' })).statusCode).toBe(400);
    expect((await signInApp(h, u.username, { deviceName: '   ' })).statusCode).toBe(400);
  });

  it('asks for the authenticator code when two-factor is on', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    const auth = authServiceFor(h.ctx);
    const { secret } = auth.twoFactor.beginTotp(u.id, u.username);
    const recovery = auth.twoFactor.enableTotp(u.id, totpCode(secret, new Date(Date.now() - 30_000)));
    const first = await signInApp(h, u.username);
    expect([first.statusCode, first.json().code]).toEqual([401, 'TOTP_REQUIRED']);
    expect((await signInApp(h, u.username, { totp: '000000' })).json().code).toBe('TOTP_INVALID');
    const ok = await signInApp(h, u.username, { totp: totpCode(secret, new Date()) });
    expect(ok.statusCode).toBe(200);
    expect((await signInApp(h, u.username, { recoveryCode: recovery[0] })).statusCode).toBe(200);
  });

  it('rate-limits failed sign-ins per address', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    for (let i = 0; i < 10; i++) await post(h, '/api/v1/app/sign-in', { username: u.username, password: 'wrong-pass', ...DEVICE }, {}, '192.0.2.50');
    const res = await post(h, '/api/v1/app/sign-in', { username: u.username, password: 'password1', ...DEVICE }, {}, '192.0.2.50');
    expect([res.statusCode, res.json().code]).toEqual([429, 'RATE_LIMITED']);
  });

  it('keeps passwords out of the audit log', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    await signInApp(h, u.username);
    const text = JSON.stringify(h.db.select().from(schema.auditEvents).all());
    expect(text).not.toContain('password1');
    expect(text).toContain('app.device.create');
  });
});

describe('QR pairing', () => {
  it('a signed-in browser makes a code; the app trades it once for a token', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    const made = await post(h, '/api/v1/app/pair-codes', undefined, { cookie: u.cookie });
    expect(made.statusCode).toBe(201);
    const code = made.json();
    expect(code.code).toMatch(new RegExp(`^[${APP_PAIR_CODE_ALPHABET}]{8}$`));
    expect(Date.parse(code.expiresAt) - h.clock.t).toBe(APP_PAIR_CODE_TTL_MS);
    expect(parseAppPairingUri(code.qr)).toEqual({ server: code.serverUrl, code: code.code });
    expect(code.serverUrl).toMatch(/^http:\/\/localhost(:\d+)?$/);

    // Typed with a dash and in lower case works too.
    const typed = `${code.code.slice(0, 4).toLowerCase()}-${code.code.slice(4)}`;
    const paired = await post(h, '/api/v1/app/pair', { code: typed, ...DEVICE, platform: 'ios' });
    expect(paired.statusCode).toBe(200);
    expect(paired.json()).toMatchObject({ user: { id: u.id }, deviceId: expect.any(Number) });
    expect(h.db.select().from(schema.appDevices).all()[0]).toMatchObject({ method: 'pairing', platform: 'ios' });
    // One time only.
    const again = await post(h, '/api/v1/app/pair', { code: code.code, ...DEVICE });
    expect([again.statusCode, again.json().code]).toEqual([401, 'PAIR_CODE_INVALID']);
  });

  it('uses the Application URL when one is set', async () => {
    const h = await harness();
    setSection(h.db, 'requests', { applicationUrl: 'https://media.example.org/' });
    const u = await makeUser(h, { player: true });
    const code = (await post(h, '/api/v1/app/pair-codes', undefined, { cookie: u.cookie })).json();
    expect(code.serverUrl).toBe('https://media.example.org');
    expect(code.qr).toBe(`arclight://pair?server=${encodeURIComponent('https://media.example.org')}&code=${code.code}`);
  });

  it('codes expire after five minutes; a new code replaces the old one', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    const first = (await post(h, '/api/v1/app/pair-codes', undefined, { cookie: u.cookie })).json();
    const second = (await post(h, '/api/v1/app/pair-codes', undefined, { cookie: u.cookie })).json();
    expect((await post(h, '/api/v1/app/pair', { code: first.code, ...DEVICE })).json().code).toBe('PAIR_CODE_INVALID');
    h.clock.t += APP_PAIR_CODE_TTL_MS + 1;
    const late = await post(h, '/api/v1/app/pair', { code: second.code, ...DEVICE });
    expect([late.statusCode, late.json().code]).toEqual([410, 'PAIR_CODE_EXPIRED']);
  });

  it('rate-limits making codes and guessing them; needs player access and a browser session', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    for (let i = 0; i < PAIR_CODES_PER_WINDOW; i++) expect((await post(h, '/api/v1/app/pair-codes', undefined, { cookie: u.cookie })).statusCode).toBe(201);
    const limited = await post(h, '/api/v1/app/pair-codes', undefined, { cookie: u.cookie });
    expect([limited.statusCode, limited.json().code]).toEqual([429, 'RATE_LIMITED']);

    for (let i = 0; i < 10; i++) await post(h, '/api/v1/app/pair', { code: 'AAAAAAAA', ...DEVICE }, {}, '192.0.2.60');
    expect((await post(h, '/api/v1/app/pair', { code: 'BBBBBBBB', ...DEVICE }, {}, '192.0.2.60')).statusCode).toBe(429);

    const denied = await makeUser(h);
    expect((await post(h, '/api/v1/app/pair-codes', undefined, { cookie: denied.cookie })).json().code).toBe('PLAYER_NOT_ALLOWED');
    expect((await post(h, '/api/v1/app/pair-codes', undefined)).statusCode).toBe(401);
    // An app token cannot mint codes for more devices.
    const token = (await signInApp(h, (await makeUser(h, { player: true })).username)).json().token;
    expect((await post(h, '/api/v1/app/pair-codes', undefined, bearer(token))).statusCode).toBe(403);
  });
});

describe('the device token', () => {
  it('works on portal routes, keeps admin rights and needs no cookie', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    const token = (await signInApp(h, u.username)).json().token;
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer(token) });
    expect([me.statusCode, me.json().id]).toEqual([200, u.id]);
    const status = await h.app.inject({ method: 'GET', url: '/api/v1/auth/status', headers: bearer(token) });
    expect(status.json()).toMatchObject({ authenticated: true, session: { via: 'app', user: { id: u.id } } });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/playback/me', headers: bearer(token) })).statusCode).toBe(200);
    // Admin-only routes stay closed to a user's token.
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/settings/player', headers: bearer(token) })).statusCode).toBe(403);

    const admin = await makeUser(h, { role: 'admin' });
    const adminToken = (await signInApp(h, admin.username)).json().token;
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/settings/player', headers: bearer(adminToken) })).statusCode).toBe(200);
    // Own credentials stay with the web app.
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/user/me/apikeys', headers: bearer(adminToken) })).statusCode).toBe(403);
  });

  it('a wrong token is anonymous, never another credential', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer('alt_notarealtoken') });
    expect(res.statusCode).toBe(401);
  });

  it('records when it was last used, at most once a minute', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    const token = (await signInApp(h, u.username)).json().token;
    const seen = () => h.db.select().from(schema.appDevices).all()[0]!.lastSeenAt;
    const first = seen();
    h.clock.t += 10_000;
    await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer(token) });
    expect(seen()).toBe(first);
    h.clock.t += APP_DEVICE_TOUCH_MS;
    await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer(token) });
    expect(seen()).toBe(new Date(h.clock.t).toISOString());
  });
});

describe('devices', () => {
  it('lists own devices, marks the current one and removes them', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    const a = (await signInApp(h, u.username)).json();
    const b = (await signInApp(h, u.username, { deviceName: 'Tablet' })).json();
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/app/devices', headers: bearer(a.token) });
    expect(list.json().map((d: { name: string; current: boolean }) => [d.name, d.current])).toEqual([
      ['Test Phone', true],
      ['Tablet', false],
    ]);
    // Someone else cannot see or remove them.
    const other = await makeUser(h, { player: true });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/app/devices', headers: { cookie: other.cookie } })).json()).toEqual([]);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/app/devices/${b.deviceId}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/app/devices?all=true', headers: { cookie: other.cookie } })).statusCode).toBe(403);

    const removed = await h.app.inject({ method: 'DELETE', url: `/api/v1/app/devices/${b.deviceId}`, headers: { cookie: u.cookie } });
    expect(removed.statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer(b.token) })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer(a.token) })).statusCode).toBe(200);
  });

  it('admins list and remove anyone’s devices', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    const device = (await signInApp(h, u.username)).json();
    const admin = await makeUser(h, { role: 'admin' });
    const all = await h.app.inject({ method: 'GET', url: '/api/v1/app/devices?all=true', headers: { cookie: admin.cookie } });
    expect(all.json()).toEqual([expect.objectContaining({ id: device.deviceId, userId: u.id, userName: u.username })]);
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/app/devices?userId=${admin.id}`, headers: { cookie: admin.cookie } })).json()).toEqual([]);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/app/devices/${device.deviceId}`, headers: { cookie: admin.cookie } })).statusCode).toBe(204);
    expect(h.db.select().from(schema.appDevices).all()).toHaveLength(0);
  });

  it('sign-out ends the calling token; sign-out everywhere ends every device', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    const a = (await signInApp(h, u.username)).json();
    const b = (await signInApp(h, u.username)).json();
    expect((await post(h, '/api/v1/app/sign-out', undefined, { cookie: u.cookie })).json().code).toBe('NOT_APP');
    expect((await post(h, '/api/v1/app/sign-out', undefined, bearer(a.token))).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer(a.token) })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer(b.token) })).statusCode).toBe(200);
    authServiceFor(h.ctx).revokeAllSessions(u.id);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer(b.token) })).statusCode).toBe(401);
  });
});

describe('CORS for the app', () => {
  it.each(['capacitor://localhost', 'https://localhost', 'http://localhost'])('answers the preflight from %s with the Authorization header', async (origin) => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/playback/items',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('authorization');
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('allows %s from the app (progress, queue, devices)', async (method) => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/playback/queue',
      headers: { origin: 'https://localhost', 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(String(res.headers['access-control-allow-methods']).split(',').map((m) => m.trim())).toContain(method);
  });

  it('exposes the download headers to the app', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/system/ping', headers: { origin: 'capacitor://localhost' } });
    expect(String(res.headers['access-control-expose-headers'])).toContain('content-disposition');
  });
});

describe('TV sign-in (device codes)', () => {
  const TV = { deviceName: 'Living Room TV', platform: 'android-tv', appVersion: '2.0.0' } as const;
  const create = (h: Harness, body: object = TV, ip?: string) => post(h, '/api/v1/app/device-codes', body, {}, ip);
  const poll = (h: Harness, pollToken: string) => post(h, '/api/v1/app/device-codes/poll', { pollToken });
  const approve = (h: Harness, userCode: string, headers: Record<string, string>) => post(h, '/api/v1/app/device-codes/approve', { userCode }, headers);

  it('the TV shows a code, a signed-in browser approves it, and the next poll gets a device token once', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    const res = await create(h, { ...TV, serverUrl: 'http://media.example.com:8080/' });
    expect(res.statusCode).toBe(201);
    const code = res.json();
    expect(code.userCode).toMatch(new RegExp(`^[${APP_PAIR_CODE_ALPHABET}]{8}$`));
    expect(code).toMatchObject({ intervalSec: 5, verifyUrl: 'http://media.example.com:8080/player/link' });
    expect(Date.parse(code.expiresAt) - h.clock.t).toBe(APP_DEVICE_CODE_TTL_MS);
    expect((await poll(h, code.pollToken)).json()).toEqual({ status: 'pending' });

    // Typed with a dash and in lower case, as people do.
    const typed = `${code.userCode.slice(0, 4)}-${code.userCode.slice(4)}`.toLowerCase();
    const ok = await approve(h, typed, { cookie: u.cookie });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ deviceName: 'Living Room TV', platform: 'android-tv' });
    // A second approval of the same code fails.
    expect((await approve(h, code.userCode, { cookie: u.cookie })).json().code).toBe('DEVICE_CODE_INVALID');

    h.clock.t += 5000;
    const done = await poll(h, code.pollToken);
    expect(done.statusCode).toBe(200);
    const body = done.json();
    expect(body).toMatchObject({ status: 'approved', user: { id: u.id } });
    expect(body.token).toMatch(/^alt_/);
    const row = h.db.select().from(schema.appDevices).all()[0]!;
    expect(row).toMatchObject({ userId: u.id, name: 'Living Room TV', platform: 'android', appVersion: '2.0.0', method: 'device-code' });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/app/devices', headers: bearer(body.token) })).statusCode).toBe(200);
    // Single use: the poll token is spent.
    h.clock.t += 5000;
    expect((await poll(h, code.pollToken)).json()).toEqual({ status: 'expired' });
    const actions = h.db.select().from(schema.auditEvents).all().map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['app.device-code.approve', 'login.success']));
  });

  it('uses the Application URL when the TV sends no address; codes expire', async () => {
    const h = await harness();
    setSection(h.db, 'requests', { applicationUrl: 'https://arclight.example.com' });
    const code = (await create(h)).json();
    expect(code.verifyUrl).toBe('https://arclight.example.com/player/link');
    h.clock.t += APP_DEVICE_CODE_TTL_MS + 1;
    expect((await poll(h, code.pollToken)).json()).toEqual({ status: 'expired' });
    const u = await makeUser(h, { player: true });
    expect((await approve(h, code.userCode, { cookie: u.cookie })).statusCode).toBe(404);
    expect((await poll(h, 'not-a-real-poll-token')).json()).toEqual({ status: 'expired' });
  });

  it('limits polling speed and codes per address', async () => {
    const h = await harness();
    const code = (await create(h, TV, '198.51.100.7')).json();
    expect((await poll(h, code.pollToken)).statusCode).toBe(200);
    expect((await poll(h, code.pollToken)).statusCode).toBe(429);
    h.clock.t += 2500;
    expect((await poll(h, code.pollToken)).statusCode).toBe(200);
    for (let i = 1; i < 10; i++) expect((await create(h, TV, '198.51.100.7')).statusCode).toBe(201);
    expect((await create(h, TV, '198.51.100.7')).statusCode).toBe(429);
    expect((await create(h, TV, '198.51.100.8')).statusCode).toBe(201);
    h.clock.t += 11 * 60_000;
    expect((await create(h, TV, '198.51.100.7')).statusCode).toBe(201);
  });

  it('approving needs player access and a browser session; codes are validated', async () => {
    const h = await harness();
    const code = (await create(h)).json();
    const nope = await makeUser(h, { player: false });
    expect((await approve(h, code.userCode, { cookie: nope.cookie })).statusCode).toBe(403);
    expect((await approve(h, code.userCode, {})).statusCode).toBe(401);
    const u = await makeUser(h, { player: true });
    const token = (await signInApp(h, u.username)).json().token;
    expect((await approve(h, code.userCode, bearer(token))).statusCode).toBe(403);
    expect((await approve(h, 'ZZZZZZZZ', { cookie: u.cookie })).json().code).toBe('DEVICE_CODE_INVALID');
    expect((await create(h, { ...TV, platform: 'tizen' })).statusCode).toBe(400);
    // Still pending after the failed attempts.
    expect((await poll(h, code.pollToken)).json()).toEqual({ status: 'pending' });
  });
});

describe('0.24 hardening', () => {
  it('a device token unused for 90 days stops working and is removed (AUTH-21)', async () => {
    const h = await harness();
    const u = await makeUser(h, { player: true });
    const token = (await signInApp(h, u.username)).json().token;
    h.clock.t += APP_DEVICE_IDLE_MS - 60_000;
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer(token) })).statusCode).toBe(200);
    // Used just now: the idle clock restarts.
    h.clock.t += APP_DEVICE_IDLE_MS - 60_000;
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer(token) })).statusCode).toBe(200);
    h.clock.t += APP_DEVICE_IDLE_MS + 1;
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/user/me', headers: bearer(token) })).statusCode).toBe(401);
    expect(h.db.select().from(schema.appDevices).all()).toEqual([]);
    expect(h.db.select().from(schema.auditEvents).all().map((r) => r.action)).toContain('app.device.expired');
  });

  it('a full device-code table drops the oldest code instead of refusing new TVs (AUTH-13)', async () => {
    const h = await harness();
    const TV = { deviceName: 'TV', platform: 'android-tv', appVersion: '2.0.0' };
    const create = (ip: string) => post(h, '/api/v1/app/device-codes', TV, {}, ip);
    const first = (await create('198.51.100.1')).json();
    for (let i = 1; i < MAX_PENDING_DEVICE_CODES; i++) {
      const res = await create(`198.51.${100 + Math.floor(i / 10)}.${(i % 10) + 1}`);
      expect(res.statusCode).toBe(201);
    }
    // The table is full: a new TV still gets a code, the oldest one goes.
    expect((await create('203.0.113.9')).statusCode).toBe(201);
    expect((await post(h, '/api/v1/app/device-codes/poll', { pollToken: first.pollToken })).json()).toEqual({ status: 'expired' });
  });

  it('an app token may not import a configuration or restore a backup (DATA-13)', async () => {
    const h = await harness();
    const admin = await makeUser(h, { role: 'admin' });
    const token = (await signInApp(h, admin.username)).json().token;
    const imported = await post(h, '/api/v1/config/import', { settings: { security: { apiKey: 'a'.repeat(32) } } }, bearer(token));
    expect(imported.statusCode).toBe(403);
    expect((await post(h, '/api/v1/system/backup/restore/1', {}, bearer(token))).statusCode).toBe(403);
    expect((await post(h, '/api/v1/system/backup/restore/upload', undefined, bearer(token))).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'PUT', url: '/api/v1/settings/vpn', headers: bearer(token), payload: {} })).statusCode).toBe(403);
    // Reading stays open to the admin's app.
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/settings/vpn', headers: bearer(token) })).statusCode).toBe(200);
  });
});
