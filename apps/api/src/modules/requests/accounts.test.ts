import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { MediaServerSettings, Permission as P, REQUEST_SECRET_MASK, RequestsSettings } from '@arclight/shared';
import { users } from '../../db/schema.js';
import { authModule, authServiceFor, installAuth, SESSION_COOKIE } from '../auth/index.js';
import { setSection } from '../settings/service.js';
import { deviceIdFor, localUsernameFrom } from './accounts.js';
import { requestsModuleWith } from './index.js';
import { configureServer, FakeMediaServers } from './media-server-fakes.js';
import { addUser, setup } from './test-support.js';
import { mediaServerLinkOf } from './users.js';


async function harness() {
  const servers = new FakeMediaServers();
  const h = await setup({ extra: { fetch: servers.fetch, plexTvUrl: 'http://plextv.test' } });
  servers.jellyfin.users.push({ id: 'jf-alice', name: 'Alice Smith', password: 'pw' }, { id: 'jf-bob', name: 'bob', password: 'pw2', isAdmin: true });
  return { ...h, servers, accounts: h.services.accounts };
}

describe('media server settings', () => {
  it('masks the API key, keeps it when the mask is sent back, and needs Manage settings', async () => {
    const h = await harness();
    const admin = addUser(h.db, { role: 'admin' });
    const plain = addUser(h.db);
    const saved = h.accounts.updateSettings(admin.actor, MediaServerSettings.parse({ kind: 'jellyfin', url: 'http://jf.test/', apiKey: 'secret' }));
    expect(saved).toMatchObject({ kind: 'jellyfin', url: 'http://jf.test', apiKey: REQUEST_SECRET_MASK });
    h.accounts.updateSettings(admin.actor, { ...saved, name: 'Den' });
    expect(h.accounts.stored()).toMatchObject({ apiKey: 'secret', name: 'Den' });
    expect(() => h.accounts.settings(plain.actor)).toThrow(/permission/);
    expect(() => h.accounts.updateSettings(admin.actor, MediaServerSettings.parse({ kind: 'emby', url: 'ftp://x', apiKey: 'k' }))).toThrow(/http/);
  });

  it('tests the connection against System/Info (stored or posted settings)', async () => {
    const h = await harness();
    const admin = addUser(h.db, { role: 'admin' });
    configureServer(h.db, h.servers, 'jellyfin');
    expect(await h.accounts.test(admin.actor)).toEqual({ ok: true, serverName: 'Den', version: '10.10.0' });
    const bad = await h.accounts.test(admin.actor, MediaServerSettings.parse({ kind: 'jellyfin', url: 'http://jf.test', apiKey: 'wrong' }));
    expect(bad.ok).toBe(false);
    configureServer(h.db, h.servers, 'plex');
    expect(await h.accounts.test(admin.actor)).toMatchObject({ ok: true, version: '1.41' });
  });
});

describe('linking a user to their media server account', () => {
  it('links with Jellyfin credentials, masks the token, and refuses a second local user for the same account', async () => {
    const h = await harness();
    configureServer(h.db, h.servers, 'jellyfin');
    const u = addUser(h.db);
    const other = addUser(h.db);
    const out = await h.accounts.link(u.actor, u.id, { username: 'alice smith', password: 'pw' });
    expect(out.mediaServerLink).toMatchObject({ kind: 'jellyfin', externalId: 'jf-alice', username: 'Alice Smith', accessToken: REQUEST_SECRET_MASK });
    expect(h.accounts.linkOf(u.id)).toMatchObject({ accessToken: 'tok-jellyfin-jf-alice', deviceId: deviceIdFor('jellyfin', 'alice smith') });
    expect(h.services.requests.requestSettings(u.actor, u.id).mediaServerLink?.accessToken).toBe(REQUEST_SECRET_MASK);
    await expect(h.accounts.link(other.actor, other.id, { username: 'Alice Smith', password: 'pw' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(h.accounts.link(u.actor, u.id, { username: 'alice smith', password: 'nope' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.accounts.link(other.actor, u.id, { username: 'bob', password: 'pw2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a PUT of request settings cannot overwrite the link; unlink removes it', async () => {
    const h = await harness();
    configureServer(h.db, h.servers, 'jellyfin');
    const u = addUser(h.db);
    await h.accounts.link(u.actor, u.id, { username: 'bob', password: 'pw2' });
    const current = h.services.requests.requestSettings(u.actor, u.id);
    h.services.requests.setRequestSettings(u.actor, u.id, { ...current, mediaServerLink: { kind: 'emby', externalId: 'evil', username: 'x', linkedAt: 'now' }, watchlistSyncMovies: true });
    expect(h.accounts.linkOf(u.id)).toMatchObject({ kind: 'jellyfin', externalId: 'jf-bob', accessToken: 'tok-jellyfin-jf-bob' });
    expect(h.accounts.unlink(u.actor, u.id).mediaServerLink).toBeUndefined();
    expect(h.accounts.linkOf(u.id)).toBeUndefined();
  });

  it('links a Plex account from an approved PIN and stores the token for the Plex watchlist', async () => {
    const h = await harness();
    const u = addUser(h.db);
    const pin = await h.accounts.plexPin();
    await expect(h.accounts.link(u.actor, u.id, { pinId: pin.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    h.servers.plex.approve(pin.id, 'user-plex-token', { id: 77, username: 'carol' });
    const out = await h.accounts.link(u.actor, u.id, { pinId: pin.id });
    expect(out).toMatchObject({ plexToken: REQUEST_SECRET_MASK, mediaServerLink: { kind: 'plex', externalId: '77', username: 'carol' } });
    expect(h.db.select().from(users).all().find((r) => r.id === u.id)?.settings).toMatchObject({ plexToken: 'user-plex-token' });
    h.accounts.unlink(u.actor, u.id);
    expect(h.db.select().from(users).all().find((r) => r.id === u.id)?.settings['plexToken']).toBeUndefined();
  });
});

describe('Jellyfin/Emby sign-in', () => {
  it('creates a local user (role user, default permissions) on first sign-in and reuses it after', async () => {
    const h = await harness();
    configureServer(h.db, h.servers, 'jellyfin');
    setSection(h.db, 'requests', RequestsSettings.parse({ defaultPermissions: P.REQUEST | P.AUTO_REQUEST }));
    const id = await h.accounts.login('jellyfin', 'Alice Smith', 'pw');
    expect(id).not.toBeNull();
    const row = h.db.select().from(users).all().find((r) => r.id === id)!;
    expect(row).toMatchObject({ username: 'Alice_Smith', displayName: 'Alice Smith', role: 'user', permissions: P.REQUEST | P.AUTO_REQUEST });
    expect(mediaServerLinkOf(row)).toMatchObject({ kind: 'jellyfin', externalId: 'jf-alice', accessToken: 'tok-jellyfin-jf-alice' });
    expect(row.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(await h.accounts.login('mediaServer', 'alice smith', 'pw')).toBe(id);
    expect(h.db.select().from(users).all()).toHaveLength(1);
  });

  it('wrong credentials answer null; a method mismatch, disabled login or disabled account refuse', async () => {
    const h = await harness();
    configureServer(h.db, h.servers, 'jellyfin');
    h.servers.jellyfin.users.push({ id: 'jf-off', name: 'off', password: 'pw', isDisabled: true });
    expect(await h.accounts.login('jellyfin', 'bob', 'wrong')).toBeNull();
    await expect(h.accounts.login('emby', 'bob', 'pw2')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(h.accounts.login('jellyfin', 'off', 'pw')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    configureServer(h.db, h.servers, 'jellyfin', { loginEnabled: false });
    await expect(h.accounts.login('jellyfin', 'bob', 'pw2')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('without createUsersOnLogin only already linked accounts may sign in', async () => {
    const h = await harness();
    configureServer(h.db, h.servers, 'jellyfin', { createUsersOnLogin: false });
    await expect(h.accounts.login('jellyfin', 'bob', 'pw2')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const u = addUser(h.db);
    await h.accounts.link(u.actor, u.id, { username: 'bob', password: 'pw2' });
    expect(await h.accounts.login('jellyfin', 'bob', 'pw2')).toBe(u.id);
  });

  it('works the same against Emby', async () => {
    const h = await harness();
    configureServer(h.db, h.servers, 'emby');
    h.servers.emby.users.push({ id: 'em-1', name: 'dave', password: 'x' });
    const id = await h.accounts.login('emby', 'dave', 'x');
    expect(mediaServerLinkOf(h.db.select().from(users).all().find((r) => r.id === id)!)).toMatchObject({ kind: 'emby', externalId: 'em-1' });
  });

  it('turns any server name into a valid, unique local username', async () => {
    expect(localUsernameFrom('Zoë & Co')).toBe('Zo_Co');
    expect(localUsernameFrom('x')).toBe('user_x');
    const h = await harness();
    configureServer(h.db, h.servers, 'jellyfin');
    addUser(h.db, { username: 'bob' });
    const id = await h.accounts.login('jellyfin', 'bob', 'pw2');
    expect(h.db.select().from(users).all().find((r) => r.id === id)?.username).toBe('bob-2');
  });
});

describe('importing media server users', () => {
  it('lists server users with their linked local user and imports the unlinked, enabled ones', async () => {
    const h = await harness();
    configureServer(h.db, h.servers, 'jellyfin');
    h.servers.jellyfin.users.push({ id: 'jf-off', name: 'off', password: 'x', isDisabled: true });
    const admin = addUser(h.db, { role: 'admin' });
    await h.accounts.link(admin.actor, admin.id, { username: 'bob', password: 'pw2' });
    const listed = await h.accounts.listServerUsers(admin.actor);
    expect(listed.map((u) => [u.externalId, u.linkedUserId, u.isDisabled])).toEqual([
      ['jf-alice', null, false],
      ['jf-bob', admin.id, false],
      ['jf-off', null, true],
    ]);
    const out = await h.accounts.importUsers(admin.actor, {});
    expect(out.created.map((c) => c.externalId)).toEqual(['jf-alice']);
    expect(out.skipped).toEqual([
      { externalId: 'jf-bob', reason: 'already linked' },
      { externalId: 'jf-off', reason: 'disabled on the media server' },
    ]);
    expect((await h.accounts.importUsers(admin.actor, { externalIds: ['jf-alice', 'ghost'] })).skipped).toEqual([
      { externalId: 'ghost', reason: 'not on the media server' },
      { externalId: 'jf-alice', reason: 'already linked' },
    ]);
    await expect(h.accounts.listServerUsers(addUser(h.db).actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('imports Plex friends as Plex-linked users', async () => {
    const h = await harness();
    configureServer(h.db, h.servers, 'plex');
    h.servers.plex.friends = [{ id: 8, username: 'erin', email: 'Erin@x.io' }];
    const admin = addUser(h.db, { role: 'admin' });
    const out = await h.accounts.importUsers(admin.actor, {});
    const row = h.db.select().from(users).all().find((r) => r.id === out.created[0]!.id)!;
    expect(row).toMatchObject({ username: 'erin', email: 'erin@x.io', role: 'user' });
    expect(mediaServerLinkOf(row)).toMatchObject({ kind: 'plex', externalId: '8' });
  });

  it('needs a configured server', async () => {
    const h = await harness();
    await expect(h.accounts.listServerUsers(addUser(h.db, { role: 'admin' }).actor)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});

describe('Plex PIN sign-in', () => {
  it('stays pending until approved, then creates a user who can reach the configured server', async () => {
    const h = await harness();
    configureServer(h.db, h.servers, 'plex');
    const pin = await h.accounts.plexPin();
    expect(await h.accounts.plexSignIn(pin.id)).toBeNull();
    h.servers.plex.approve(pin.id, 'frank-token', { id: 9, username: 'frank', email: 'f@x.io', thumb: 'https://plex.tv/users/9/avatar' }, [h.servers.plex.machineId]);
    const id = await h.accounts.plexSignIn(pin.id);
    const row = h.db.select().from(users).all().find((r) => r.id === id)!;
    expect(row).toMatchObject({ username: 'frank', avatar: 'https://plex.tv/users/9/avatar', role: 'user' });
    expect(row.settings).toMatchObject({ plexToken: 'frank-token' });
  });

  it('refuses accounts without access to the server unless already linked', async () => {
    const h = await harness();
    configureServer(h.db, h.servers, 'plex');
    const pin = await h.accounts.plexPin();
    h.servers.plex.approve(pin.id, 'stranger', { id: 10, username: 'stranger' }, ['some-other-server']);
    await expect(h.accounts.plexSignIn(pin.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const u = addUser(h.db);
    const linkPin = await h.accounts.plexPin();
    h.servers.plex.approve(linkPin.id, 'stranger', { id: 10, username: 'stranger' }, []);
    await h.accounts.link(u.actor, u.id, { pinId: linkPin.id });
    expect(await h.accounts.plexSignIn(pin.id)).toBe(u.id);
  });
});

describe('sign-in over HTTP', () => {
  async function app() {
    const h = await harness();
    configureServer(h.db, h.servers, 'jellyfin');
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
    return { ...h, server };
  }

  it('POST /auth/login with method jellyfin signs in (creating the user) and sets the session cookie', async () => {
    const h = await app();
    const res = await h.server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { method: 'jellyfin', username: 'bob', password: 'pw2' } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=`);
    expect(res.json()).toMatchObject({ via: 'session', isAdmin: false, user: { username: 'bob', role: 'user' } });
    const bad = await h.server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { method: 'jellyfin', username: 'bob', password: 'x' } });
    expect(bad.statusCode).toBe(401);
    // A local login for the created account does not work: its password is unguessable.
    const local = await h.server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'bob', password: 'pw2' } });
    expect(local.statusCode).toBe(401);
  });

  it('the Plex PIN routes are public; poll answers 202 until approved, then 200 with a cookie', async () => {
    const h = await app();
    configureServer(h.db, h.servers, 'plex');
    const pin = await h.server.inject({ method: 'POST', url: '/api/v1/auth/plex/pin' });
    expect(pin.statusCode).toBe(200);
    const { id } = pin.json() as { id: number };
    const pending = await h.server.inject({ method: 'POST', url: '/api/v1/auth/plex/poll', payload: { id } });
    expect(pending.statusCode).toBe(202);
    h.servers.plex.approve(id, 'grace-token', { id: 11, username: 'grace' }, [h.servers.plex.machineId]);
    const done = await h.server.inject({ method: 'POST', url: '/api/v1/auth/plex/poll', payload: { id } });
    expect(done.statusCode).toBe(200);
    expect(String(done.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=`);
    expect(done.json()).toMatchObject({ user: { username: 'grace' } });
  });

  it('import routes need Manage users', async () => {
    const h = await app();
    const auth = authServiceFor(h.ctx);
    const admin = addUser(h.db, { role: 'admin' });
    const plain = addUser(h.db);
    const cookie = (id: number) => `${SESSION_COOKIE}=${auth.createSession(id).token}`;
    const denied = await h.server.inject({ method: 'GET', url: '/api/v1/user/import/mediaserver', headers: { cookie: cookie(plain.id) } });
    expect(denied.statusCode).toBe(403);
    const listed = await h.server.inject({ method: 'GET', url: '/api/v1/user/import/mediaserver', headers: { cookie: cookie(admin.id) } });
    expect(listed.json()).toHaveLength(2);
    const imported = await h.server.inject({ method: 'POST', url: '/api/v1/user/import/mediaserver', headers: { cookie: cookie(admin.id) }, payload: { externalIds: ['jf-alice'] } });
    expect(imported.json()).toMatchObject({ created: [{ externalId: 'jf-alice' }] });
    const settings = await h.server.inject({ method: 'GET', url: '/api/v1/settings/mediaserver', headers: { cookie: cookie(admin.id) } });
    expect(settings.json()).toMatchObject({ kind: 'jellyfin', apiKey: REQUEST_SECRET_MASK });
  });
});
