import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { authModule, authServiceFor, installAuth, SESSION_COOKIE } from '../auth/index.js';
import { cookieFrom } from '../auth/test-support.js';
import { requestsModuleWith } from './index.js';
import { configureServer, FakeMediaServers } from './media-server-fakes.js';
import { PLEX_PIN_COOKIE, PLEX_PIN_TTL_MS, PlexPinGuard, PlexPinRateLimited } from './plex-pins.js';
import { addUser, setup } from './test-support.js';

// AUTH-04: Plex PINs finish only in the browser (and for the account) that created them, once.

async function app() {
  const servers = new FakeMediaServers();
  const h = await setup({ extra: { fetch: servers.fetch, plexTvUrl: 'http://plextv.test' } });
  configureServer(h.db, servers, 'plex');
  addUser(h.db, { role: 'admin' });
  const server = Fastify().withTypeProvider<ZodTypeProvider>();
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  await server.register(
    async (api) => {
      installAuth(api, h.ctx);
      await api.register(requestsModuleWith({})(h.ctx));
      await api.register(authModule(h.ctx));
    },
    { prefix: '/api/v1' },
  );
  await server.ready();
  const session = (id: number) => `${SESSION_COOKIE}=${authServiceFor(h.ctx).createSession(id).token}`;
  return { ...h, server, servers, session };
}

type App = Awaited<ReturnType<typeof app>>;

async function newPin(h: App, url = '/api/v1/auth/plex/pin', cookie?: string, remoteAddress = '127.0.0.1') {
  const res = await h.server.inject({ method: 'POST', url, remoteAddress, ...(cookie ? { headers: { cookie } } : {}) });
  expect(res.statusCode).toBe(200);
  return { id: (res.json() as { id: number }).id, binding: cookieFrom(res, PLEX_PIN_COOKIE) };
}

function poll(h: App, id: number, cookie?: string, url = '/api/v1/auth/plex/poll', remoteAddress = '127.0.0.1') {
  return h.server.inject({ method: 'POST', url, remoteAddress, payload: { id }, ...(cookie ? { headers: { cookie } } : {}) });
}

describe('Plex PIN sign-in binding', () => {
  it('sets an HttpOnly short-lived binding cookie with the pin', async () => {
    const h = await app();
    const res = await h.server.inject({ method: 'POST', url: '/api/v1/auth/plex/pin' });
    const raw = [res.headers['set-cookie']].flat().map(String).find((c) => c.startsWith(`${PLEX_PIN_COOKIE}=`))!;
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain(`Max-Age=${PLEX_PIN_TTL_MS / 1000}`);
  });

  it('refuses a poll without the cookie of the browser that created the pin, and finishes only once', async () => {
    const h = await app();
    const victim = await newPin(h);
    const attacker = await newPin(h);
    h.servers.plex.approve(victim.id, 'grace-token', { id: 11, username: 'grace' }, [h.servers.plex.machineId]);
    // No cookie, or another pin's cookie: 403, and plex.tv is never asked.
    expect((await poll(h, victim.id)).statusCode).toBe(403);
    expect((await poll(h, victim.id, attacker.binding)).statusCode).toBe(403);
    const done = await poll(h, victim.id, victim.binding);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ user: { username: 'grace' } });
    const cookies = [done.headers['set-cookie']].flat().map(String);
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${PLEX_PIN_COOKIE}=;`) && c.includes('Max-Age=0'))).toBe(true);
    // The pin is spent, even with the right cookie.
    expect((await poll(h, victim.id, victim.binding)).statusCode).toBe(403);
  });

  it('answers 202 while pending and keeps the pin usable', async () => {
    const h = await app();
    const pin = await newPin(h);
    expect((await poll(h, pin.id, pin.binding)).statusCode).toBe(202);
    h.servers.plex.approve(pin.id, 'tok-h', { id: 12, username: 'heidi' }, [h.servers.plex.machineId]);
    expect((await poll(h, pin.id, pin.binding)).statusCode).toBe(200);
  });

  it('binds the link poll to the user who created the pin', async () => {
    const h = await app();
    const owner = addUser(h.db);
    const other = addUser(h.db);
    const ownerSession = h.session(owner.id);
    const pin = await newPin(h, '/api/v1/user/me/mediaserver/plex/pin', ownerSession);
    h.servers.plex.approve(pin.id, 'owner-plex-token', { id: 21, username: 'ownerplex' }, []);
    const linkUrl = '/api/v1/user/me/mediaserver/plex/poll';
    // Another user (even holding the cookie) cannot attach this Plex account to themselves.
    expect((await poll(h, pin.id, `${h.session(other.id)}; ${pin.binding}`, linkUrl)).statusCode).toBe(403);
    expect((await poll(h, pin.id, ownerSession, linkUrl)).statusCode).toBe(403);
    // A link pin cannot be used to sign in, either.
    expect((await poll(h, pin.id, pin.binding)).statusCode).toBe(403);
    const linked = await poll(h, pin.id, `${ownerSession}; ${pin.binding}`, linkUrl);
    expect(linked.statusCode).toBe(200);
    expect(h.services.accounts.linkOf(owner.id)).toMatchObject({ kind: 'plex', externalId: '21' });
    expect(h.services.accounts.linkOf(other.id)).toBeUndefined();
    expect((await poll(h, pin.id, `${ownerSession}; ${pin.binding}`, linkUrl)).statusCode).toBe(403);
  });

  it('binds POST /user/:id/mediaserver/link {pinId} to the pin creator', async () => {
    const h = await app();
    const owner = addUser(h.db);
    const ownerSession = h.session(owner.id);
    const signInPin = await newPin(h);
    h.servers.plex.approve(signInPin.id, 'tok-x', { id: 31, username: 'x' }, []);
    const link = (cookie: string, pinId: number) => h.server.inject({ method: 'POST', url: `/api/v1/user/${owner.id}/mediaserver/link`, headers: { cookie }, payload: { pinId } });
    // A pin created anonymously (or by anyone else) does not link.
    expect((await link(`${ownerSession}; ${signInPin.binding}`, signInPin.id)).statusCode).toBe(403);
    const pin = await newPin(h, '/api/v1/user/me/mediaserver/plex/pin', ownerSession);
    h.servers.plex.approve(pin.id, 'tok-y', { id: 32, username: 'y' }, []);
    expect((await link(ownerSession, pin.id)).statusCode).toBe(403);
    expect((await link(`${ownerSession}; ${pin.binding}`, pin.id)).statusCode).toBe(200);
    expect((await link(`${ownerSession}; ${pin.binding}`, pin.id)).statusCode).toBe(403);
  });

  it('rate-limits pin creation per address', async () => {
    const h = await app();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await h.server.inject({ method: 'POST', url: '/api/v1/auth/plex/pin', remoteAddress: '192.0.2.7' })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    const limited = await h.server.inject({ method: 'POST', url: '/api/v1/auth/plex/pin', remoteAddress: '192.0.2.7' });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another address is unaffected.
    expect((await h.server.inject({ method: 'POST', url: '/api/v1/auth/plex/pin', remoteAddress: '192.0.2.8' })).statusCode).toBe(200);
  });

  it('rate-limits polls per pin and per address', async () => {
    const h = await app();
    const pin = await newPin(h);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await poll(h, pin.id, pin.binding)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    // Guessing ids from one address runs into the per-address limit.
    const guesses: number[] = [];
    for (let id = 1000; id < 1070; id++) guesses.push((await poll(h, id, undefined, undefined, '198.51.100.9')).statusCode);
    expect(guesses.slice(0, 60).every((c) => c === 403)).toBe(true);
    expect(guesses.at(-1)).toBe(429);
  });
});

describe('PlexPinGuard', () => {
  it('expires bindings and lets one poll at a time through', () => {
    let t = 0;
    const guard = new PlexPinGuard(() => t);
    const binding = guard.bind(5, null);
    expect(guard.claim(5, binding, null)).toBe('ok');
    expect(guard.claim(5, binding, null)).toBe('busy');
    guard.release(5);
    expect(guard.claim(5, 'wrong', null)).toBe('forbidden');
    expect(guard.claim(5, binding, 7)).toBe('forbidden');
    t += PLEX_PIN_TTL_MS;
    expect(guard.claim(5, binding, null)).toBe('forbidden');
  });

  it('throws a rate-limit error with a retry hint', () => {
    const guard = new PlexPinGuard(() => 0);
    for (let i = 0; i < 10; i++) guard.throttleCreate('p');
    expect(() => guard.throttleCreate('p')).toThrow(PlexPinRateLimited);
  });
});
