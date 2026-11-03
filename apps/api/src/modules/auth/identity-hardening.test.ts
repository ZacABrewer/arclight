import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { startFakeIdp, type FakeIdp, type FakeIdpUser } from './fake-idp.js';
import { OIDC_BINDING_COOKIE } from './routes-identity.js';
import type { IdentityServiceOptions } from './identity.js';
import { buildAuthApp, cookieFrom } from './test-support.js';

// AUTH-11 (self-set emails are unverified and unique), AUTH-12 (OIDC start limits) and AUTH-23
// (forward-auth may be kept away from admin accounts).

const ADMIN = { username: 'admin', password: 'password1' };

async function readyApp(identity: Partial<Omit<IdentityServiceOptions, 'db' | 'auth'>> = {}) {
  const clock = { now: Date.now() };
  const ctx = await buildAuthApp({ now: () => new Date(clock.now) }, { now: () => new Date(clock.now), ...identity });
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: ADMIN });
  const cookie = cookieFrom(res);
  await ctx.app.inject({ method: 'POST', url: '/api/v1/setup/complete', headers: { cookie }, payload: {} });
  return { ...ctx, cookie, clock };
}

type Ready = Awaited<ReturnType<typeof readyApp>>;

async function createUser(r: Ready, username: string, extra: Record<string, unknown> = {}) {
  const res = await r.app.inject({ method: 'POST', url: '/api/v1/user', headers: { cookie: r.cookie }, payload: { username, password: 'password1', ...extra } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: number; username: string };
}

async function sessionOf(r: Ready, username: string) {
  return cookieFrom(await r.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'password1' } }));
}

function setOwnEmail(r: Ready, cookie: string, email: string) {
  return r.app.inject({ method: 'PUT', url: '/api/v1/user/me', headers: { cookie }, payload: { email } });
}

function verifiedOf(r: Ready, id: number): boolean {
  return r.db.select().from(users).where(eq(users.id, id)).get()!.emailVerified;
}

describe('self-service email changes', () => {
  it('refuses an email another account already uses, whatever its case', async () => {
    const r = await readyApp();
    await createUser(r, 'victim', { email: 'victim@example.com' });
    const eve = await createUser(r, 'eve');
    const res = await setOwnEmail(r, await sessionOf(r, 'eve'), 'Victim@Example.com');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'EMAIL_IN_USE' });
    expect(r.db.select().from(users).where(eq(users.id, eve.id)).get()!.email).toBeNull();
  });

  it('marks a changed email unverified, keeps an unchanged one, and an admin edit verifies it', async () => {
    const r = await readyApp();
    const bob = await createUser(r, 'bob', { email: 'bob@example.com' });
    expect(verifiedOf(r, bob.id)).toBe(true);
    const session = await sessionOf(r, 'bob');
    expect((await setOwnEmail(r, session, 'bob@example.com')).statusCode).toBe(200);
    expect(verifiedOf(r, bob.id)).toBe(true);
    expect((await setOwnEmail(r, session, 'bob@example.org')).statusCode).toBe(200);
    expect(verifiedOf(r, bob.id)).toBe(false);
    const admin = await r.app.inject({ method: 'PUT', url: `/api/v1/user/${bob.id}`, headers: { cookie: r.cookie }, payload: { email: 'bob@example.org' } });
    expect(admin.statusCode).toBe(200);
    expect(verifiedOf(r, bob.id)).toBe(true);
  });
});

describe('OpenID Connect and unverified emails', () => {
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
  }

  async function signIn(r: Ready, user: FakeIdpUser) {
    const start = await r.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/test/start?returnTo=%2Fportal' });
    expect(start.statusCode).toBe(302);
    const { callbackPath } = idp.authorize(String(start.headers.location), user);
    return r.app.inject({ method: 'GET', url: callbackPath, headers: { cookie: cookieFrom(start, OIDC_BINDING_COOKIE) } });
  }

  async function signedInAs(r: Ready, cb: Awaited<ReturnType<typeof signIn>>) {
    const me = await r.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieFrom(cb) } });
    return (me.json() as { user: { id: number; username: string } }).user;
  }

  const victim: FakeIdpUser = { sub: 'sub-victim', email: 'victim@example.com', email_verified: true, preferred_username: 'victim' };

  it('does not link a verified provider email to an account that typed that email itself', async () => {
    const r = await readyApp();
    const eve = await createUser(r, 'eve');
    expect((await setOwnEmail(r, await sessionOf(r, 'eve'), 'victim@example.com')).statusCode).toBe(200);
    await withProvider(r);
    const refused = await signIn(r, victim);
    expect(String(refused.headers.location)).toContain('ssoError=no_account');
    // With account creation on, the victim gets their own account, not eve's.
    await withProvider(r, { autoCreate: true });
    const created = await signIn(r, victim);
    expect(created.headers.location).toBe('/portal');
    const user = await signedInAs(r, created);
    expect(user.id).not.toBe(eve.id);
    expect(user.username).toBe('victim');
  });

  it('still links emails an admin set (and accounts from before 0.24)', async () => {
    const r = await readyApp();
    const dave = await createUser(r, 'dave', { email: 'victim@example.com' });
    await withProvider(r);
    const cb = await signIn(r, victim);
    expect(cb.headers.location).toBe('/portal');
    expect((await signedInAs(r, cb)).id).toBe(dave.id);
  });

  it('ignores unverified self-set duplicates instead of refusing the real owner', async () => {
    const r = await readyApp();
    const owner = await createUser(r, 'owner', { email: 'shared@example.com' });
    // Seeded directly: the API refuses duplicates now, but older data may hold them.
    const squatter = await createUser(r, 'squatter');
    r.db.update(users).set({ email: 'shared@example.com', emailVerified: false }).where(eq(users.id, squatter.id)).run();
    await withProvider(r);
    const cb = await signIn(r, { sub: 'sub-owner', email: 'shared@example.com', email_verified: true });
    expect(cb.headers.location).toBe('/portal');
    expect((await signedInAs(r, cb)).id).toBe(owner.id);
  });

  it('a provider that verified the address vouches for the account it signs in', async () => {
    const r = await readyApp();
    const frank = await createUser(r, 'frank', { email: 'frank@example.com' });
    await withProvider(r);
    expect((await signIn(r, { sub: 'sub-frank', email: 'frank@example.com', email_verified: true })).headers.location).toBe('/portal');
    expect((await setOwnEmail(r, await sessionOf(r, 'frank'), 'frank@example.org')).statusCode).toBe(200);
    expect(verifiedOf(r, frank.id)).toBe(false);
    // Signed in through its existing link, the provider now verifies the new address.
    expect((await signIn(r, { sub: 'sub-frank', email: 'frank@example.org', email_verified: true })).headers.location).toBe('/portal');
    expect(verifiedOf(r, frank.id)).toBe(true);
  });

  it('rate-limits sign-in starts per address and refuses rather than evicts when an address holds too many', async () => {
    const r = await readyApp();
    await withProvider(r, { autoCreate: true });
    const start = (remoteAddress: string) => r.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/test/start', remoteAddress });
    const first = await start('192.0.2.10');
    const locations: string[] = [];
    for (let i = 0; i < 21; i++) locations.push(String((await start('192.0.2.66')).headers.location));
    expect(locations.slice(0, 20).every((l) => l.startsWith(idp.issuer))).toBe(true);
    // The 21st start from the flooding address is refused...
    expect(locations.at(-1)).toContain('ssoError=rate_limited');
    // ...another address still starts, and the earlier attempt still completes.
    expect(String((await start('192.0.2.11')).headers.location).startsWith(idp.issuer)).toBe(true);
    const { callbackPath } = idp.authorize(String(first.headers.location), { sub: 'sub-zoe', email: 'zoe@example.com', email_verified: true, preferred_username: 'zoe' });
    const cb = await r.app.inject({ method: 'GET', url: callbackPath, headers: { cookie: cookieFrom(first, OIDC_BINDING_COOKIE) } });
    expect(cb.headers.location).toBe('/');
    expect(cookieFrom(cb)).toMatch(/^al_session=.+/);
  });

  it('caps unfinished attempts per address even under a generous rate limit', async () => {
    const r = await readyApp({ startLimit: { capacity: 1000, refillPerSecond: 100 } });
    await withProvider(r);
    const start = () => r.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/test/start', remoteAddress: '198.51.100.4' });
    for (let i = 0; i < 20; i++) expect(String((await start()).headers.location).startsWith(idp.issuer)).toBe(true);
    expect(String((await start()).headers.location)).toContain('ssoError=rate_limited');
    // Unfinished attempts expire, and then the address may start again.
    r.clock.now += 11 * 60_000;
    expect(String((await start()).headers.location).startsWith(idp.issuer)).toBe(true);
  });
});

describe('forward-auth and admins', () => {
  async function enable(r: Ready, extra: Record<string, unknown> = {}) {
    const res = await r.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/identity',
      headers: { cookie: r.cookie },
      payload: { forwardAuth: { enabled: true, trustedProxies: ['10.0.0.0/8'], ...extra } },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { forwardAuth: { allowAdmins: boolean } };
  }
  const probe = (r: Ready, headers: Record<string, string>) => r.app.inject({ method: 'GET', url: '/api/v1/auth/me', remoteAddress: '10.0.0.5', headers });

  it('signs in admins by default, as before', async () => {
    const r = await readyApp();
    expect((await enable(r)).forwardAuth.allowAdmins).toBe(true);
    expect((await probe(r, { 'remote-user': 'admin' })).json()).toMatchObject({ via: 'forward', isAdmin: true });
  });

  it('with allowAdmins off, ignores headers that name or would promote an admin', async () => {
    const r = await readyApp();
    await createUser(r, 'bob');
    await enable(r, { allowAdmins: false, autoCreate: true, adminGroups: ['arclight-admins'] });
    expect((await probe(r, { 'remote-user': 'admin' })).statusCode).toBe(401);
    expect((await probe(r, { 'remote-user': 'bob' })).json()).toMatchObject({ via: 'forward', isAdmin: false });
    // Group-based promotion of an existing user, and creating an admin, are refused too.
    expect((await probe(r, { 'remote-user': 'bob', 'remote-groups': 'arclight-admins' })).statusCode).toBe(401);
    expect(r.db.select().from(users).where(eq(users.usernameKey, 'bob')).get()!.role).toBe('user');
    expect((await probe(r, { 'remote-user': 'newadmin', 'remote-groups': 'arclight-admins' })).statusCode).toBe(401);
    expect(r.db.select().from(users).where(eq(users.usernameKey, 'newadmin')).get()).toBeUndefined();
  });

  it('matches forward-auth emails only when they are verified', async () => {
    const r = await readyApp();
    const carl = await createUser(r, 'carl');
    expect((await setOwnEmail(r, await sessionOf(r, 'carl'), 'boss@example.com')).statusCode).toBe(200);
    await enable(r);
    expect((await probe(r, { 'remote-user': 'boss', 'remote-email': 'boss@example.com' })).statusCode).toBe(401);
    r.db.update(users).set({ emailVerified: true }).where(eq(users.id, carl.id)).run();
    expect((await probe(r, { 'remote-user': 'boss', 'remote-email': 'boss@example.com' })).json()).toMatchObject({ user: { username: 'carl' } });
  });
});
