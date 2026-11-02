import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { startFakeIdp, type FakeIdp, type FakeIdpUser, type TokenTweaks } from './fake-idp.js';
import { groupDecision, safeReturnTo } from './identity.js';
import { OIDC_BINDING_COOKIE } from './routes-identity.js';
import { SoftAuthenticator } from './soft-authenticator.js';
import { buildAuthApp, cookieFrom } from './test-support.js';
import { invalidProxyEntries, TrustedProxies } from './trusted-proxies.js';
import { generateRecoveryCodes, hashRecoveryCode, totpCode, totpStep, verifyTotp, base32Encode } from './totp.js';

const ADMIN = { username: 'admin', password: 'password1' };
const T0 = Date.parse('2026-06-01T12:00:00Z');

/** Fresh app with an admin (signed in) and setup completed; `clock` moves time. */
async function readyApp() {
  // Real time: the fake provider signs tokens with the wall clock.
  const clock = { now: Date.now() };
  const ctx = await buildAuthApp({ now: () => new Date(clock.now) }, { now: () => new Date(clock.now) });
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: ADMIN });
  const cookie = cookieFrom(res);
  await ctx.app.inject({ method: 'POST', url: '/api/v1/setup/complete', headers: { cookie }, payload: {} });
  return { ...ctx, cookie, clock };
}

type Ready = Awaited<ReturnType<typeof readyApp>>;

async function login(app: Ready['app'], body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: body });
}

async function createUser(r: Ready, username: string, extra: Record<string, unknown> = {}) {
  const res = await r.app.inject({ method: 'POST', url: '/api/v1/user', headers: { cookie: r.cookie }, payload: { username, password: 'password1', ...extra } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: number; username: string };
}

/** Turns TOTP on for the session's account; returns the secret and recovery codes. */
async function enableTotp(r: Ready, cookie: string) {
  const setup = await r.app.inject({ method: 'POST', url: '/api/v1/user/me/2fa/totp/setup', headers: { cookie } });
  expect(setup.statusCode).toBe(200);
  const { secret, uri } = setup.json() as { secret: string; uri: string };
  expect(uri).toMatch(/^otpauth:\/\/totp\//);
  const enable = await r.app.inject({ method: 'POST', url: '/api/v1/user/me/2fa/totp/enable', headers: { cookie }, payload: { code: totpCode(secret, new Date(r.clock.now)) } });
  expect(enable.statusCode).toBe(200);
  return { secret, codes: (enable.json() as { codes: string[] }).codes };
}

// ---------------------------------------------------------------------------------- TOTP

describe('TOTP', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 SHA1 test vectors', () => {
    // RFC 6238 appendix B (8 digits there; the last 6 here).
    expect(totpCode(secret, new Date(59_000))).toBe('287082');
    expect(totpCode(secret, new Date(1111111109_000))).toBe('081804');
    expect(totpCode(secret, new Date(2000000000_000))).toBe('279037');
  });

  it('accepts one step either side and nothing further', () => {
    const at = new Date(T0);
    const step = totpStep(at);
    for (const offset of [-1, 0, 1]) {
      expect(verifyTotp(secret, totpCode(secret, new Date(T0 + offset * 30_000)), at)).toBe(step + offset);
    }
    for (const offset of [-3, -2, 2, 3]) {
      expect(verifyTotp(secret, totpCode(secret, new Date(T0 + offset * 30_000)), at)).toBeNull();
    }
    expect(verifyTotp(secret, 'abcdef', at)).toBeNull();
    expect(verifyTotp(secret, '12345', at)).toBeNull();
  });

  it('refuses a code at or before the last used step (replay)', () => {
    const at = new Date(T0);
    const step = totpStep(at);
    const code = totpCode(secret, at);
    expect(verifyTotp(secret, code, at, step - 1)).toBe(step);
    expect(verifyTotp(secret, code, at, step)).toBeNull();
    // An older code still inside the window is refused once a newer step was used.
    expect(verifyTotp(secret, totpCode(secret, new Date(T0 - 30_000)), at, step)).toBeNull();
  });

  it('makes distinct recovery codes and hashes them format-insensitively', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    const c = codes[0]!;
    expect(hashRecoveryCode(c)).toBe(hashRecoveryCode(c.toUpperCase().replace('-', ' ')));
  });
});

// ---------------------------------------------------------------------------------- trusted proxies

describe('trusted proxies', () => {
  it('matches IPs and CIDRs, v4, v6 and v4-mapped v6', () => {
    const t = new TrustedProxies(['10.0.0.0/8', '172.18.0.2', 'fd00::/8']);
    expect(t.trusts('10.1.2.3')).toBe(true);
    expect(t.trusts('::ffff:10.1.2.3')).toBe(true);
    expect(t.trusts('172.18.0.2')).toBe(true);
    expect(t.trusts('172.18.0.3')).toBe(false);
    expect(t.trusts('fd12::1')).toBe(true);
    expect(t.trusts('192.0.2.1')).toBe(false);
    expect(t.trusts(undefined)).toBe(false);
    expect(new TrustedProxies([]).trusts('127.0.0.1')).toBe(false);
  });

  it('reports invalid entries', () => {
    expect(invalidProxyEntries(['10.0.0.0/8', 'proxy.example.com', '10.0.0.0/33', '::1'])).toEqual(['proxy.example.com', '10.0.0.0/33']);
  });
});

describe('helpers', () => {
  it('keeps returnTo inside the app', () => {
    expect(safeReturnTo('/portal?x=1')).toBe('/portal?x=1');
    for (const bad of ['https://evil.example.com', '//evil.example.com', '/\\evil.example.com', 'portal', '', undefined, 5]) expect(safeReturnTo(bad)).toBe('/');
  });

  it('decides groups case-insensitively', () => {
    expect(groupDecision(['Arclight-Admins'], { adminGroups: ['arclight-admins'], allowedGroups: [] })).toEqual({ allowed: true, role: 'admin' });
    expect(groupDecision(['family'], { adminGroups: ['arclight-admins'], allowedGroups: ['family'] })).toEqual({ allowed: true, role: 'user' });
    expect(groupDecision(['guests'], { adminGroups: [], allowedGroups: ['family'] })).toEqual({ allowed: false, role: null });
    expect(groupDecision([], { adminGroups: [], allowedGroups: [] })).toEqual({ allowed: true, role: null });
  });
});

// ---------------------------------------------------------------------------------- two-factor sign-in

describe('two-factor sign-in', () => {
  it('asks for the second factor, takes a TOTP code once and a recovery code once', async () => {
    const r = await readyApp();
    const { secret, codes } = await enableTotp(r, r.cookie);
    expect(codes).toHaveLength(10);

    const first = await login(r.app, ADMIN);
    expect(first.statusCode).toBe(200);
    expect(first.headers['set-cookie']).toBeUndefined();
    const challenge = first.json() as { twoFactorRequired: true; challenge: string; methods: string[] };
    expect(challenge).toMatchObject({ twoFactorRequired: true, methods: ['totp', 'recovery'] });

    // The code used to enable is already spent (same step).
    const replay = await r.app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa', payload: { challenge: challenge.challenge, code: totpCode(secret, new Date(r.clock.now)) } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('INVALID_CREDENTIALS');

    r.clock.now += 30_000;
    const code = totpCode(secret, new Date(r.clock.now));
    const ok = await r.app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa', payload: { challenge: challenge.challenge, code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ via: 'session', user: { username: 'admin' } });
    const session = cookieFrom(ok);
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: session } })).statusCode).toBe(200);

    // The challenge is single use.
    const again = await r.app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa', payload: { challenge: challenge.challenge, code } });
    expect(again.statusCode).toBe(401);
    expect(again.json().code).toBe('CHALLENGE_EXPIRED');

    // The same code on a fresh challenge: replay refused.
    const second = (await login(r.app, ADMIN)).json() as { challenge: string };
    expect((await r.app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa', payload: { challenge: second.challenge, code } })).statusCode).toBe(401);

    // A recovery code works once.
    const third = (await login(r.app, ADMIN)).json() as { challenge: string };
    const rec = await r.app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa', payload: { challenge: third.challenge, recoveryCode: codes[0] } });
    expect(rec.statusCode).toBe(200);
    const fourth = (await login(r.app, ADMIN)).json() as { challenge: string };
    const recAgain = await r.app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa', payload: { challenge: fourth.challenge, recoveryCode: codes[0] } });
    expect(recAgain.statusCode).toBe(401);
    const status = await r.app.inject({ method: 'GET', url: '/api/v1/user/me/2fa', headers: { cookie: session } });
    expect(status.json()).toMatchObject({ totp: true, recoveryCodesLeft: 9, passkeys: 0 });
  });

  it('expires challenges and drops them after too many wrong codes', async () => {
    const r = await readyApp();
    await enableTotp(r, r.cookie);
    const a = (await login(r.app, ADMIN)).json() as { challenge: string };
    r.clock.now += 6 * 60_000;
    const late = await r.app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa', payload: { challenge: a.challenge, code: '000000' } });
    expect(late.json().code).toBe('CHALLENGE_EXPIRED');

    const b = (await login(r.app, ADMIN)).json() as { challenge: string };
    for (let i = 0; i < 5; i++) {
      const wrong = await r.app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa', payload: { challenge: b.challenge, recoveryCode: `wrong-code-${i}` } });
      expect(wrong.statusCode).toBe(401);
    }
    const dropped = await r.app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa', payload: { challenge: b.challenge, recoveryCode: 'wrong-code-x' } });
    expect(dropped.json().code).toBe('CHALLENGE_EXPIRED');
  });

  it('refuses Basic for accounts with a second factor, and lets an admin reset it', async () => {
    const r = await readyApp();
    const user = await createUser(r, 'alice');
    const aliceCookie = cookieFrom(await login(r.app, { username: 'alice', password: 'password1' }));
    await enableTotp(r, aliceCookie);
    r.auth.updateAuthSettings({ ...r.auth.authSettings(), method: 'basic' });
    const basic = `Basic ${Buffer.from('alice:password1').toString('base64')}`;
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Basic ${Buffer.from('admin:password1').toString('base64')}` } })).statusCode).toBe(200);
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: basic } })).statusCode).toBe(401);
    // Existing session ended by the admin reset.
    const reset = await r.app.inject({ method: 'DELETE', url: `/api/v1/user/${user.id}/2fa`, headers: { cookie: r.cookie } });
    expect(reset.statusCode).toBe(204);
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: aliceCookie } })).statusCode).toBe(401);
    const plain = await login(r.app, { username: 'alice', password: 'password1' });
    expect(plain.json()).toMatchObject({ via: 'session', user: { username: 'alice' } });
    // Non-admins cannot reset anyone.
    const aliceAgain = cookieFrom(plain);
    expect((await r.app.inject({ method: 'DELETE', url: `/api/v1/user/1/2fa`, headers: { cookie: aliceAgain } })).statusCode).toBe(403);
  });

  it('turning TOTP off needs a valid code', async () => {
    const r = await readyApp();
    const { codes } = await enableTotp(r, r.cookie);
    const wrong = await r.app.inject({ method: 'DELETE', url: '/api/v1/user/me/2fa/totp', headers: { cookie: r.cookie }, payload: { code: '000000' } });
    expect(wrong.statusCode).toBe(401);
    const ok = await r.app.inject({ method: 'DELETE', url: '/api/v1/user/me/2fa/totp', headers: { cookie: r.cookie }, payload: { recoveryCode: codes[1] } });
    expect(ok.statusCode).toBe(204);
    expect((await login(r.app, ADMIN)).json()).toMatchObject({ via: 'session' });
  });
});

describe('require two-factor for admins', () => {
  it('cannot be turned on by an admin without a second factor', async () => {
    const r = await readyApp();
    const res = await r.app.inject({ method: 'PUT', url: '/api/v1/settings/identity', headers: { cookie: r.cookie }, payload: { requireTwoFactorForAdmins: true } });
    expect(res.statusCode).toBe(400);
  });

  it('locks other admins without a factor to the 2FA setup until they add one', async () => {
    const r = await readyApp();
    await createUser(r, 'second', { role: 'admin' });
    await enableTotp(r, r.cookie);
    const put = await r.app.inject({ method: 'PUT', url: '/api/v1/settings/identity', headers: { cookie: r.cookie }, payload: { requireTwoFactorForAdmins: true } });
    expect(put.statusCode).toBe(200);
    expect(put.json().requireTwoFactorForAdmins).toBe(true);

    const s = cookieFrom(await login(r.app, { username: 'second', password: 'password1' }));
    const me = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s } });
    expect(me.json().twoFactorSetupRequired).toBe(true);
    const blocked = await r.app.inject({ method: 'GET', url: '/api/v1/user', headers: { cookie: s } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('TWO_FACTOR_SETUP_REQUIRED');
    // Basic is held to the same rule.
    r.auth.updateAuthSettings({ ...r.auth.authSettings(), method: 'basic' });
    const basic = `Basic ${Buffer.from('second:password1').toString('base64')}`;
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/user', headers: { authorization: basic } })).json().code).toBe('TWO_FACTOR_SETUP_REQUIRED');

    await enableTotp(r, s);
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/user', headers: { cookie: s } })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------------- per-user API keys

describe('per-user API keys', () => {
  async function keyFor(r: Ready, cookie: string, scope: string) {
    const res = await r.app.inject({ method: 'POST', url: '/api/v1/user/me/apikeys', headers: { cookie }, payload: { name: `${scope} key`, scope } });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: number; key: string; prefix: string };
  }

  it('creates, lists (without the key), records use and revokes', async () => {
    const r = await readyApp();
    const k = await keyFor(r, r.cookie, 'admin');
    expect(k.key).toMatch(/^alu_/);
    const probe = await r.app.inject({ method: 'GET', url: '/api/v1/probe', headers: { 'x-api-key': k.key } });
    expect(probe.json()).toEqual({ via: 'userkey', user: 'admin' });
    const list = await r.app.inject({ method: 'GET', url: '/api/v1/user/me/apikeys', headers: { cookie: r.cookie } });
    const [row] = list.json() as { key?: string; lastUsedAt?: string; prefix: string }[];
    expect(row?.key).toBeUndefined();
    expect(row?.lastUsedAt).toBeDefined();
    expect(k.key.startsWith(row!.prefix)).toBe(true);
    expect((await r.app.inject({ method: 'DELETE', url: `/api/v1/user/me/apikeys/${k.id}`, headers: { cookie: r.cookie } })).statusCode).toBe(204);
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/probe', headers: { 'x-api-key': k.key } })).statusCode).toBe(401);
  });

  it('read keys only read; requests keys never act as admin; secrets need an admin key', async () => {
    const r = await readyApp();
    const read = await keyFor(r, r.cookie, 'read');
    const requests = await keyFor(r, r.cookie, 'requests');
    const admin = await keyFor(r, r.cookie, 'admin');

    expect((await r.app.inject({ method: 'GET', url: '/api/v1/user', headers: { 'x-api-key': read.key } })).statusCode).toBe(200);
    expect((await r.app.inject({ method: 'POST', url: '/api/v1/probe', headers: { 'x-api-key': read.key } })).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/settings/security', headers: { 'x-api-key': read.key } })).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/settings/identity', headers: { 'x-api-key': read.key } })).statusCode).toBe(403);

    // requests: the portal's rights only, not the admin app.
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/user', headers: { 'x-api-key': requests.key } })).statusCode).toBe(403);
    const me = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-api-key': requests.key } });
    expect(me.json()).toMatchObject({ via: 'userkey', isAdmin: false, apiKeyScope: 'requests' });

    expect((await r.app.inject({ method: 'GET', url: '/api/v1/settings/security', headers: { 'x-api-key': admin.key } })).statusCode).toBe(200);

    // No key manages credentials, whatever its scope.
    for (const key of [read.key, admin.key]) {
      expect((await r.app.inject({ method: 'POST', url: '/api/v1/user/me/apikeys', headers: { 'x-api-key': key }, payload: { name: 'x', scope: 'admin' } })).statusCode).toBe(403);
      expect((await r.app.inject({ method: 'GET', url: '/api/v1/user/me/2fa', headers: { 'x-api-key': key } })).statusCode).toBe(403);
    }
  });

  it('non-admins cannot mint admin keys, and a demoted admin key acts as requests', async () => {
    const r = await readyApp();
    const alice = await createUser(r, 'alice', { role: 'admin' });
    const aliceCookie = cookieFrom(await login(r.app, { username: 'alice', password: 'password1' }));
    const k = await keyFor(r, aliceCookie, 'admin');
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/user', headers: { 'x-api-key': k.key } })).statusCode).toBe(200);
    await r.app.inject({ method: 'PUT', url: `/api/v1/user/${alice.id}`, headers: { cookie: r.cookie }, payload: { role: 'user' } });
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/user', headers: { 'x-api-key': k.key } })).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-api-key': k.key } })).json().apiKeyScope).toBe('requests');

    const userCookie = cookieFrom(await login(r.app, { username: 'alice', password: 'password1' }));
    const denied = await r.app.inject({ method: 'POST', url: '/api/v1/user/me/apikeys', headers: { cookie: userCookie }, payload: { name: 'x', scope: 'admin' } });
    expect(denied.statusCode).toBe(403);
    // Admins see and revoke every key.
    const all = await r.app.inject({ method: 'GET', url: '/api/v1/apikeys', headers: { cookie: r.cookie } });
    expect((all.json() as { username: string }[]).map((x) => x.username)).toEqual(['alice']);
    expect((await r.app.inject({ method: 'DELETE', url: `/api/v1/apikeys/${k.id}`, headers: { cookie: r.cookie } })).statusCode).toBe(204);
  });

  it('expired keys stop working and the global key still works', async () => {
    const r = await readyApp();
    const res = await r.app.inject({ method: 'POST', url: '/api/v1/user/me/apikeys', headers: { cookie: r.cookie }, payload: { name: 'short', scope: 'read', expiresInDays: 1 } });
    const { key } = res.json() as { key: string };
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/probe', headers: { 'x-api-key': key } })).statusCode).toBe(200);
    r.clock.now += 2 * 86_400_000;
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/probe', headers: { 'x-api-key': key } })).statusCode).toBe(401);
    const global = r.auth.apiKey();
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/probe', headers: { 'x-api-key': global } })).json().via).toBe('apikey');
  });
});

// ---------------------------------------------------------------------------------- forward-auth

describe('forward-auth', () => {
  async function enable(r: Ready, extra: Record<string, unknown> = {}) {
    const res = await r.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/identity',
      headers: { cookie: r.cookie },
      payload: { forwardAuth: { enabled: true, trustedProxies: ['10.0.0.0/8'], ...extra } },
    });
    expect(res.statusCode).toBe(200);
  }

  it('is off by default', async () => {
    const r = await readyApp();
    const res = await r.app.inject({ method: 'GET', url: '/api/v1/probe', remoteAddress: '10.1.2.3', headers: { 'remote-user': 'admin' } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses to turn on without trusted proxies or with junk entries', async () => {
    const r = await readyApp();
    const none = await r.app.inject({ method: 'PUT', url: '/api/v1/settings/identity', headers: { cookie: r.cookie }, payload: { forwardAuth: { enabled: true } } });
    expect(none.statusCode).toBe(400);
    const junk = await r.app.inject({ method: 'PUT', url: '/api/v1/settings/identity', headers: { cookie: r.cookie }, payload: { forwardAuth: { enabled: true, trustedProxies: ['proxy.example.com'] } } });
    expect(junk.statusCode).toBe(400);
  });

  it('signs in from a trusted proxy and ignores the headers from anyone else', async () => {
    const r = await readyApp();
    await enable(r);
    const trusted = await r.app.inject({ method: 'GET', url: '/api/v1/probe', remoteAddress: '10.1.2.3', headers: { 'remote-user': 'admin' } });
    expect(trusted.json()).toEqual({ via: 'forward', user: 'admin' });
    // Spoofed header straight from a client.
    const spoofed = await r.app.inject({ method: 'GET', url: '/api/v1/probe', remoteAddress: '192.0.2.50', headers: { 'remote-user': 'admin' } });
    expect(spoofed.statusCode).toBe(401);
    // X-Forwarded-For claiming the proxy changes nothing: only the TCP peer counts.
    const xff = await r.app.inject({ method: 'GET', url: '/api/v1/probe', remoteAddress: '192.0.2.50', headers: { 'remote-user': 'admin', 'x-forwarded-for': '10.1.2.3' } });
    expect(xff.statusCode).toBe(401);
    // Unknown users are not created unless asked.
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/probe', remoteAddress: '10.1.2.3', headers: { 'remote-user': 'nobody' } })).statusCode).toBe(401);
  });

  it('creates accounts, applies groups and the allow list', async () => {
    const r = await readyApp();
    await enable(r, { autoCreate: true, adminGroups: ['arclight-admins'], allowedGroups: ['family'] });
    // The requests module supplies the default permissions of new accounts.
    r.auth.newUserPermissions = () => 4;
    const h = (user: string, groups: string) => ({ 'remote-user': user, 'remote-email': `${user}@example.com`, 'remote-groups': groups });
    const fam = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', remoteAddress: '10.0.0.5', headers: h('bob', 'family') });
    expect(fam.json()).toMatchObject({ via: 'forward', isAdmin: false, user: { username: 'bob', email: 'bob@example.com', role: 'user', permissions: 4 } });
    const adm = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', remoteAddress: '10.0.0.5', headers: h('carol', 'family|arclight-admins') });
    expect(adm.json()).toMatchObject({ isAdmin: true, user: { role: 'admin' } });
    const outsider = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', remoteAddress: '10.0.0.5', headers: h('mallory', 'guests') });
    expect(outsider.statusCode).toBe(401);
    expect(r.db.select().from(users).where(eq(users.usernameKey, 'mallory')).get()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------- OpenID Connect

describe('OpenID Connect sign-in', () => {
  let idp: FakeIdp;
  beforeEach(async () => {
    idp = await startFakeIdp();
  });
  afterEach(async () => {
    await idp.close();
  });

  async function withProvider(r: Ready, extra: Record<string, unknown> = {}) {
    const res = await r.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/identity',
      headers: { cookie: r.cookie },
      payload: { providers: [{ id: 'test', name: 'Test IdP', issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, ...extra }] },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { providers: { clientSecret: string }[]; redirectUris: Record<string, string> };
  }

  /** start → provider → callback; returns the callback response. */
  async function signIn(r: Ready, user: FakeIdpUser, tweaks: TokenTweaks = {}, opts: { cookie?: string; dropBinding?: boolean; returnTo?: string } = {}) {
    const start = await r.app.inject({ method: 'GET', url: `/api/v1/auth/oidc/test/start?returnTo=${encodeURIComponent(opts.returnTo ?? '/portal')}`, headers: opts.cookie ? { cookie: opts.cookie } : {} });
    expect(start.statusCode).toBe(302);
    const binding = cookieFrom(start, OIDC_BINDING_COOKIE);
    expect(binding).toMatch(/^al_oidc=.+/);
    const { callbackPath, state } = idp.authorize(String(start.headers.location), user, tweaks);
    const cookies = [opts.dropBinding ? '' : binding, opts.cookie ?? ''].filter(Boolean).join('; ');
    const cb = await r.app.inject({ method: 'GET', url: callbackPath, headers: cookies ? { cookie: cookies } : {} });
    return { start, cb, callbackPath, binding, state };
  }

  const alice: FakeIdpUser = { sub: 'sub-alice', email: 'alice@example.com', email_verified: true, preferred_username: 'alice', name: 'Alice Example' };

  it('masks the client secret, keeps it when the mask is sent back, and shows the redirect URI', async () => {
    const r = await readyApp();
    const saved = await withProvider(r);
    expect(saved.providers[0]!.clientSecret).toBe('********');
    expect(saved.redirectUris['test']).toBe('http://localhost:80/api/v1/auth/oidc/test/callback');
    const again = await r.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/identity',
      headers: { cookie: r.cookie },
      payload: { providers: [{ id: 'test', name: 'Renamed', issuer: idp.issuer, clientId: idp.clientId, clientSecret: '********' }] },
    });
    expect(again.statusCode).toBe(200);
    expect(r.identity.settings().providers[0]!.clientSecret).toBe(idp.clientSecret);
    const status = await r.app.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(status.json().signIn).toEqual({ providers: [{ id: 'test', name: 'Renamed', showOnLogin: true, showOnPortal: true }], hidePasswordLogin: false, passkeys: false });
    const test = await r.app.inject({ method: 'POST', url: '/api/v1/settings/identity/test', headers: { cookie: r.cookie }, payload: { issuer: idp.issuer } });
    expect(test.json()).toMatchObject({ ok: true, issuer: idp.issuer });
  });

  it('signs in with PKCE, state and nonce, creating the account when allowed', async () => {
    const r = await readyApp();
    await withProvider(r);
    const refused = await signIn(r, alice);
    expect(refused.cb.statusCode).toBe(302);
    expect(refused.cb.headers.location).toBe('/login?returnTo=%2Fportal&ssoError=no_account');

    await withProvider(r, { autoCreate: true });
    const { start, cb } = await signIn(r, alice);
    const auth = new URL(String(start.headers.location));
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('scope')).toBe('openid email profile');
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/portal');
    const session = cookieFrom(cb);
    const me = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: session } });
    expect(me.json()).toMatchObject({ via: 'session', isAdmin: false, user: { username: 'alice', email: 'alice@example.com', displayName: 'Alice Example', role: 'user' } });
    // PKCE verifier and client authentication reached the token endpoint.
    const tokenReq = idp.tokenRequests.at(-1)!;
    expect(tokenReq.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(tokenReq.authorization).toMatch(/^Basic /);
    const sessions = await r.app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: { cookie: session } });
    expect(sessions.json()[0].method).toBe('oidc:test');
    // A second sign-in finds the same account through its link.
    const second = await signIn(r, { ...alice, email: 'alice@example.org' });
    const me2 = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieFrom(second.cb) } });
    expect(me2.json().user.id).toBe(me.json().user.id);
  });

  it.each<[string, TokenTweaks]>([
    ['wrong issuer', { issuer: 'https://evil.example.com' }],
    ['wrong audience', { audience: 'someone-else' }],
    ['expired', { expiresIn: -600 }],
    ['foreign signing key', { foreignKey: true }],
    ['alg none', { unsigned: true }],
    ['nonce mismatch', { nonce: 'not-the-nonce' }],
    ['several audiences without azp', { audience: ['arclight', 'other'] }],
    ['azp of another client', { azp: 'other' }],
    ['userinfo for another subject', { userinfoSub: 'sub-mallory' }],
  ])('refuses an ID token with %s', async (_name, tweaks) => {
    const r = await readyApp();
    await withProvider(r, { autoCreate: true });
    const { cb } = await signIn(r, alice, tweaks);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/login?returnTo=%2Fportal&ssoError=token');
    expect(cookieFrom(cb)).not.toMatch(/^al_session=.+/);
    expect(r.db.select().from(users).where(eq(users.usernameKey, 'alice')).get()).toBeUndefined();
  });

  it('refuses replayed, unknown and unbound callbacks', async () => {
    const r = await readyApp();
    await withProvider(r, { autoCreate: true });
    const ok = await signIn(r, alice);
    expect(ok.cb.headers.location).toBe('/portal');
    // Replay of the same callback (state already used).
    const replay = await r.app.inject({ method: 'GET', url: ok.callbackPath, headers: { cookie: ok.binding } });
    expect(String(replay.headers.location)).toContain('ssoError=state');
    // Callback without the browser-binding cookie (a link sent to someone else).
    const unbound = await signIn(r, alice, {}, { dropBinding: true });
    expect(String(unbound.cb.headers.location)).toContain('ssoError=state');
    // Another browser's binding cookie.
    const a = await r.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/test/start' });
    const b = await r.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/test/start' });
    const { callbackPath } = idp.authorize(String(a.headers.location), alice);
    const crossed = await r.app.inject({ method: 'GET', url: callbackPath, headers: { cookie: cookieFrom(b, OIDC_BINDING_COOKIE) } });
    expect(String(crossed.headers.location)).toContain('ssoError=state');
    // Made-up state.
    const forged = await r.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/test/callback?code=x&state=forged', headers: { cookie: cookieFrom(b, OIDC_BINDING_COOKIE) } });
    expect(String(forged.headers.location)).toContain('ssoError=state');
    // State expires.
    const late = await r.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/test/start' });
    const lateCb = idp.authorize(String(late.headers.location), alice);
    r.clock.now += 11 * 60_000;
    const expired = await r.app.inject({ method: 'GET', url: lateCb.callbackPath, headers: { cookie: cookieFrom(late, OIDC_BINDING_COOKIE) } });
    expect(String(expired.headers.location)).toContain('ssoError=state');
  });

  it('never redirects outside the app', async () => {
    const r = await readyApp();
    await withProvider(r, { autoCreate: true });
    const { cb } = await signIn(r, alice, {}, { returnTo: '//evil.example.com/x' });
    expect(cb.headers.location).toBe('/');
  });

  it('matches a verified email to a user account, never to an admin', async () => {
    const r = await readyApp();
    await createUser(r, 'dave', { email: 'dave@example.com' });
    await r.app.inject({ method: 'PUT', url: '/api/v1/user/me', headers: { cookie: r.cookie }, payload: { email: 'admin@example.com' } });
    await withProvider(r);
    const unverified = await signIn(r, { sub: 'sub-dave', email: 'dave@example.com', email_verified: false });
    expect(String(unverified.cb.headers.location)).toContain('ssoError=no_account');
    const verified = await signIn(r, { sub: 'sub-dave', email: 'DAVE@example.com', email_verified: true });
    expect(verified.cb.headers.location).toBe('/portal');
    const me = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieFrom(verified.cb) } });
    expect(me.json().user.username).toBe('dave');
    const admin = await signIn(r, { sub: 'sub-evil', email: 'admin@example.com', email_verified: true });
    expect(String(admin.cb.headers.location)).toContain('ssoError=forbidden');
  });

  it('maps groups to roles and enforces the allow list', async () => {
    const r = await readyApp();
    await withProvider(r, { autoCreate: true, adminGroups: ['arclight-admins'], allowedGroups: ['family'] });
    const outsider = await signIn(r, { ...alice, groups: ['guests'] });
    expect(String(outsider.cb.headers.location)).toContain('ssoError=forbidden');
    const asAdmin = await signIn(r, { ...alice, groups: ['arclight-admins'] });
    const me = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieFrom(asAdmin.cb) } });
    expect(me.json()).toMatchObject({ isAdmin: true, user: { username: 'alice', role: 'admin' } });
    // Leaving the admin group demotes at the next sign-in.
    const demoted = await signIn(r, { ...alice, groups: ['family'] });
    const me2 = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieFrom(demoted.cb) } });
    expect(me2.json()).toMatchObject({ isAdmin: false, user: { role: 'user' } });
  });

  it('links and unlinks from the profile, and refuses a link owned by someone else', async () => {
    const r = await readyApp();
    await withProvider(r, { matchBy: 'none' });
    const link = await r.app.inject({ method: 'POST', url: '/api/v1/auth/oidc/test/link', headers: { cookie: r.cookie }, payload: { returnTo: '/profile' } });
    expect(link.statusCode).toBe(200);
    const { callbackPath } = idp.authorize(link.json().url, { sub: 'sub-admin', email: 'admin@example.com', email_verified: true });
    const cb = await r.app.inject({ method: 'GET', url: callbackPath, headers: { cookie: `${cookieFrom(link, OIDC_BINDING_COOKIE)}; ${r.cookie}` } });
    expect(cb.headers.location).toBe('/profile?linked=test');
    const ids = await r.app.inject({ method: 'GET', url: '/api/v1/user/me/identities', headers: { cookie: r.cookie } });
    const [identity] = ids.json() as { id: number; providerName: string; subject: string }[];
    expect(identity).toMatchObject({ providerName: 'Test IdP', subject: 'sub-admin' });

    // Now the admin signs in with the provider (admin via OIDC: no local 2FA, session method oidc).
    const signed = await signIn(r, { sub: 'sub-admin' });
    const me = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieFrom(signed.cb) } });
    expect(me.json()).toMatchObject({ isAdmin: true, user: { username: 'admin' } });

    // Another account trying to link the same provider identity.
    await createUser(r, 'erin');
    const erin = cookieFrom(await login(r.app, { username: 'erin', password: 'password1' }));
    const link2 = await r.app.inject({ method: 'POST', url: '/api/v1/auth/oidc/test/link', headers: { cookie: erin }, payload: { returnTo: '/profile' } });
    const cb2 = idp.authorize(link2.json().url, { sub: 'sub-admin' });
    const conflict = await r.app.inject({ method: 'GET', url: cb2.callbackPath, headers: { cookie: `${cookieFrom(link2, OIDC_BINDING_COOKIE)}; ${erin}` } });
    expect(conflict.headers.location).toBe('/profile?ssoError=link_conflict');

    // A link started by one user cannot be finished in another user's session.
    const link3 = await r.app.inject({ method: 'POST', url: '/api/v1/auth/oidc/test/link', headers: { cookie: erin }, payload: { returnTo: '/profile' } });
    const cb3 = idp.authorize(link3.json().url, { sub: 'sub-erin' });
    const hijack = await r.app.inject({ method: 'GET', url: cb3.callbackPath, headers: { cookie: `${cookieFrom(link3, OIDC_BINDING_COOKIE)}; ${r.cookie}` } });
    expect(String(hijack.headers.location)).toContain('ssoError=state');

    expect((await r.app.inject({ method: 'DELETE', url: `/api/v1/user/me/identities/${identity!.id}`, headers: { cookie: r.cookie } })).statusCode).toBe(204);
    const after = await signIn(r, { sub: 'sub-admin' });
    expect(String(after.cb.headers.location)).toContain('ssoError=no_account');
  });

  it('keeps an account without a password from removing its last sign-in', async () => {
    const r = await readyApp();
    await withProvider(r, { autoCreate: true });
    const { cb } = await signIn(r, alice);
    const session = cookieFrom(cb);
    const [identity] = (await r.app.inject({ method: 'GET', url: '/api/v1/user/me/identities', headers: { cookie: session } })).json() as { id: number }[];
    const res = await r.app.inject({ method: 'DELETE', url: `/api/v1/user/me/identities/${identity!.id}`, headers: { cookie: session } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('LAST_SIGN_IN_METHOD');
    // An OIDC-created account has no usable password.
    expect((await login(r.app, { username: 'alice', password: 'whatever1' })).statusCode).toBe(401);
  });

  it('sends a disabled or unknown provider back to the login page', async () => {
    const r = await readyApp();
    await withProvider(r, { enabled: false });
    const res = await r.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/test/start?returnTo=/portal' });
    expect(res.headers.location).toBe('/login?ssoError=disabled&returnTo=%2Fportal');
    const unknown = await r.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/nope/start' });
    expect(String(unknown.headers.location)).toContain('ssoError=disabled');
  });
});

// ---------------------------------------------------------------------------------- passkeys

describe('passkeys', () => {
  const ORIGIN = 'http://localhost:80';

  async function addPasskey(r: Ready, cookie: string, device: SoftAuthenticator) {
    const opts = await r.app.inject({ method: 'POST', url: '/api/v1/user/me/passkeys/options', headers: { cookie } });
    expect(opts.statusCode).toBe(200);
    const { ceremony, options } = opts.json() as { ceremony: string; options: { challenge: string; rp: { id: string } } };
    expect(options.rp.id).toBe('localhost');
    const res = await r.app.inject({ method: 'POST', url: '/api/v1/user/me/passkeys', headers: { cookie }, payload: { ceremony, name: 'Laptop', response: device.register(options, ORIGIN) } });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: number; name: string };
  }

  async function passkeyLogin(r: Ready, device: SoftAuthenticator, challenge?: string, tweak: { counter?: number } = {}) {
    const opts = await r.app.inject({ method: 'POST', url: '/api/v1/auth/passkey/options', payload: challenge ? { challenge } : {} });
    expect(opts.statusCode).toBe(200);
    const { ceremony, options } = opts.json() as { ceremony: string; options: { challenge: string; rpId: string } };
    return r.app.inject({ method: 'POST', url: '/api/v1/auth/passkey/login', payload: { ceremony, response: device.assert(options, ORIGIN, tweak), ...(challenge ? { challenge } : {}) } });
  }

  it('registers a passkey and signs in with it alone', async () => {
    const r = await readyApp();
    const device = new SoftAuthenticator();
    const pk = await addPasskey(r, r.cookie, device);
    expect(pk.name).toBe('Laptop');
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json().signIn.passkeys).toBe(true);
    const res = await passkeyLogin(r, device);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ via: 'session', user: { username: 'admin' } });
    const sessions = await r.app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: { cookie: cookieFrom(res) } });
    expect((sessions.json() as { current: boolean; method?: string }[]).find((s) => s.current)?.method).toBe('passkey');
    // The password now needs the second step, and the passkey can be that step.
    const first = (await login(r.app, ADMIN)).json() as { challenge: string; methods: string[] };
    expect(first.methods).toEqual(['passkey']);
    const second = await passkeyLogin(r, device, first.challenge);
    expect(second.statusCode).toBe(200);
  });

  it('refuses a ceremony used twice, an unknown passkey and a repeated counter', async () => {
    const r = await readyApp();
    const device = new SoftAuthenticator();
    await addPasskey(r, r.cookie, device);
    const opts = await r.app.inject({ method: 'POST', url: '/api/v1/auth/passkey/options', payload: {} });
    const { ceremony, options } = opts.json() as { ceremony: string; options: { challenge: string; rpId: string } };
    const response = device.assert(options, ORIGIN);
    expect((await r.app.inject({ method: 'POST', url: '/api/v1/auth/passkey/login', payload: { ceremony, response } })).statusCode).toBe(200);
    const replay = await r.app.inject({ method: 'POST', url: '/api/v1/auth/passkey/login', payload: { ceremony, response } });
    expect(replay.statusCode).toBe(401);
    expect((await passkeyLogin(r, new SoftAuthenticator())).statusCode).toBe(401);
    // A cloned authenticator repeats an old counter.
    expect((await passkeyLogin(r, device, undefined, { counter: 1 })).statusCode).toBe(401);
  });

  it('renames and removes passkeys', async () => {
    const r = await readyApp();
    const pk = await addPasskey(r, r.cookie, new SoftAuthenticator());
    const renamed = await r.app.inject({ method: 'PUT', url: `/api/v1/user/me/passkeys/${pk.id}`, headers: { cookie: r.cookie }, payload: { name: 'Phone' } });
    expect(renamed.json().name).toBe('Phone');
    expect((await r.app.inject({ method: 'DELETE', url: `/api/v1/user/me/passkeys/${pk.id}`, headers: { cookie: r.cookie } })).statusCode).toBe(204);
    expect((await r.app.inject({ method: 'GET', url: '/api/v1/user/me/passkeys', headers: { cookie: r.cookie } })).json()).toEqual([]);
  });
});
