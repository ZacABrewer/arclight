import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createAgent, NotificationError, type NotificationEvent } from '@arclight/notifications';
import { AlertSettings, NOTIFICATION_SECRET_MASK, Permission, type PersonalDestinationInputRaw, type QuietHoursSettings } from '@arclight/shared';
import { authServiceFor, installAuth, SESSION_COOKIE } from '../auth/index.js';
import * as requestsSchema from '../requests/schema.js';
import { addUser, makeContext, NOW, setup as requestsSetup } from '../requests/test-support.js';
import { setSection } from '../settings/service.js';
import { createTestDb } from '../../db/test-utils.js';
import { isPrivateHost, PersonalNotifications, PERSONAL_RATE_LIMIT_PER_MINUTE, privateTarget, publicError } from './personal.js';
import { notificationsRoutes } from './routes.js';
import * as tables from './schema.js';
import { NotificationsError, NotificationsService, type AgentFactory } from './service.js';

// Personal destinations: every user's own targets, the events they pick, and the guard rails
// for non-admins (no LAN targets, error categories only).

const log = pino({ level: 'silent' });

function quietAround(at: Date): QuietHoursSettings {
  const h = at.getHours();
  const pad = (n: number) => String(n % 24).padStart(2, '0');
  return { enabled: true, start: `${pad(h)}:00`, end: `${pad(h + 1)}:00`, days: [0, 1, 2, 3, 4, 5, 6] };
}

async function setup() {
  const db = await createTestDb({ ...tables, ...requestsSchema });
  let clock = new Date(NOW);
  const sent: Array<{ url: string; event: NotificationEvent }> = [];
  const failing = new Map<string, NotificationError>();
  const factory: AgentFactory = (kind, settings, templates) => {
    const real = createAgent(kind, settings, templates ? { templates } : {});
    const url = String((settings as Record<string, unknown>)['url'] ?? (settings as Record<string, unknown>)['webhookUrl']);
    return {
      kind,
      supportedEvents: real.supportedEvents,
      async send(event: NotificationEvent) {
        const err = failing.get(url);
        if (err) throw err;
        sent.push({ url, event });
      },
      async test() {},
    };
  };
  const personal = new PersonalNotifications({ db, log, now: () => clock, sleep: async () => {}, agentFactory: factory });
  const system = new NotificationsService({ db, log, now: () => clock, sleep: async () => {}, agentFactory: factory });
  system.setLibraryListener(personal);
  return {
    db,
    personal,
    system,
    sent,
    failing,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => clock,
  };
}

const dest = (name: string, extra: Partial<PersonalDestinationInputRaw> = {}, settings: Record<string, unknown> = {}): PersonalDestinationInputRaw => ({
  name,
  implementation: 'webhook',
  settings: { url: `https://hooks.example/${name}`, password: 'hunter2', ...settings },
  ...extra,
});

const approved = (userId: number, title = 'The Matrix'): NotificationEvent =>
  ({
    type: 'requestApproved',
    instanceName: 'Arclight',
    timestamp: NOW.toISOString(),
    media: { id: 0, mediaType: 'movie', title, year: 1999, tmdbId: 603, path: '', genres: [], tags: [], images: [] },
    request: { id: 1, status: 'approved', requestedBy: { id: userId, username: 'u' }, is4k: false },
  }) as unknown as NotificationEvent;

const imported = (tmdbId: number, mediaType: 'movie' | 'series' = 'movie'): NotificationEvent =>
  ({
    type: 'import',
    instanceName: 'Arclight',
    timestamp: NOW.toISOString(),
    media: { id: 1, mediaType, title: 'The Matrix', year: 1999, tmdbId, path: '/m/x', genres: [], tags: [], images: [] },
    file: { path: '/m/x/x.mkv', relativePath: 'x.mkv', quality: 'Bluray-1080p', size: 1 },
    isUpgrade: false,
  }) as unknown as NotificationEvent;

function watch(db: Awaited<ReturnType<typeof setup>>['db'], userId: number, tmdbId: number, mediaType: 'movie' | 'series' = 'movie') {
  db.insert(requestsSchema.watchlistItems)
    .values({ userId, mediaType, tmdbId, title: 'x', source: 'manual', createdAt: NOW.toISOString() } as typeof requestsSchema.watchlistItems.$inferInsert)
    .run();
}

describe('personal destinations CRUD', () => {
  it('creates, masks secrets, lists only the owner, updates with masked secrets kept and deletes', async () => {
    const h = await setup();
    const alice = addUser(h.db, { username: 'alice' });
    const bob = addUser(h.db, { username: 'bob' });
    const created = h.personal.create(alice.id, dest('phone'));
    expect(created).toMatchObject({ userId: alice.id, name: 'phone', enabled: true, quietHours: null });
    expect(created.settings['password']).toBe(NOTIFICATION_SECRET_MASK);
    expect(created.events).toEqual(['requestApproved', 'requestAvailable', 'requestDeclined', 'issueUpdated', 'watchlistAvailable']);
    expect(h.personal.list(bob.id)).toEqual([]);
    expect(JSON.stringify(h.personal.list(alice.id))).not.toContain('hunter2');
    h.personal.update(alice.id, created.id, dest('phone', { events: ['requestAvailable'] }, { password: NOTIFICATION_SECRET_MASK }));
    const row = h.db.select().from(tables.userNotificationDestinations).get();
    expect(row?.settings['password']).toBe('hunter2');
    expect(row?.events).toEqual(['requestAvailable']);
    expect(() => h.personal.update(bob.id, created.id, dest('x'))).toThrow(NotificationsError);
    expect(() => h.personal.delete(bob.id, created.id)).toThrow(/not found/);
    h.personal.delete(alice.id, created.id);
    expect(h.personal.list(alice.id)).toEqual([]);
  });

  it('rejects kinds outside the personal list and invalid settings', async () => {
    const h = await setup();
    const u = addUser(h.db);
    expect(() => h.personal.create(u.id, { ...dest('x'), implementation: 'plex' as never })).toThrow(NotificationsError);
    expect(() => h.personal.create(u.id, { ...dest('x'), settings: { url: 'not a url' } })).toThrow(NotificationsError);
  });

  it('non-admins cannot target the local network; admins can', async () => {
    const h = await setup();
    const u = addUser(h.db);
    const admin = addUser(h.db, { role: 'admin' });
    for (const url of ['http://192.168.1.5/hook', 'http://localhost:8080/x', 'http://nas.local/x', 'http://[::1]/x', 'http://gotify/x', 'http://100.64.0.1/x']) {
      expect(() => h.personal.create(u.id, dest('lan', {}, { url })), url).toThrow(/local network/);
    }
    expect(h.personal.create(admin.id, dest('lan', {}, { url: 'http://192.168.1.5/hook' })).name).toBe('lan');
  });

  it('only managers may pick the new-request and new-issue events', async () => {
    const h = await setup();
    const user = addUser(h.db);
    const manager = addUser(h.db, { permissions: Permission.REQUEST | Permission.MANAGE_REQUESTS });
    const events = ['requestApproved', 'requestPending', 'issueCreated'] as const;
    expect(h.personal.create(user.id, dest('a', { events: [...events] })).events).toEqual(['requestApproved']);
    expect(h.personal.create(manager.id, dest('b', { events: [...events] })).events).toEqual(['requestApproved', 'requestPending']);
    expect(h.personal.options(manager.id).events).toContain('requestPending');
    expect(h.personal.options(user.id).events).not.toContain('requestPending');
  });

  it('is unavailable when the admin switched personal destinations off', async () => {
    const h = await setup();
    const u = addUser(h.db);
    const created = h.personal.create(u.id, dest('phone'));
    setSection(h.db, 'alerts', AlertSettings.parse({ personalDestinations: false }));
    expect(h.personal.options(u.id).enabled).toBe(false);
    expect(() => h.personal.create(u.id, dest('more'))).toThrow(/switched off/);
    expect(await h.personal.dispatch(u.id, 'requestApproved', approved(u.id))).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.personal.list(u.id)).toHaveLength(1);
    void created;
  });
});

describe('personal dispatch', () => {
  it('sends only to enabled destinations that chose the event', async () => {
    const h = await setup();
    const u = addUser(h.db);
    h.personal.create(u.id, dest('all'));
    h.personal.create(u.id, dest('available', { events: ['requestAvailable'] }));
    h.personal.create(u.id, dest('off', { enabled: false }));
    const outcomes = await h.personal.dispatch(u.id, 'requestApproved', approved(u.id));
    expect(outcomes).toMatchObject([{ name: 'all', ok: true }]);
    expect(h.sent.map((s) => s.url)).toEqual(['https://hooks.example/all']);
    const [entry] = h.personal.deliveries(u.id, h.personal.list(u.id)[0]!.id);
    expect(entry).toMatchObject({ state: 'sent', eventType: 'requestApproved' });
  });

  it('holds during the destination quiet hours and flushes afterwards', async () => {
    const h = await setup();
    const u = addUser(h.db);
    h.personal.create(u.id, dest('night', { quietHours: quietAround(h.now()) }));
    const [outcome] = await h.personal.dispatch(u.id, 'requestApproved', approved(u.id));
    expect(outcome).toMatchObject({ held: true });
    expect(h.sent).toEqual([]);
    expect(await h.personal.flushHeld()).toBe(0);
    h.advance(2 * 3600_000);
    expect(await h.personal.flushHeld()).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  it('rate limits bursts per destination and batches the rest', async () => {
    const h = await setup();
    const u = addUser(h.db);
    h.personal.create(u.id, dest('phone'));
    for (let i = 0; i < PERSONAL_RATE_LIMIT_PER_MINUTE + 3; i++) await h.personal.dispatch(u.id, 'requestApproved', approved(u.id, `T${i}`));
    expect(h.sent).toHaveLength(PERSONAL_RATE_LIMIT_PER_MINUTE);
    h.advance(61_000);
    expect(await h.personal.flushHeld()).toBe(3);
    expect(h.sent.at(-1)?.event.type).toBe('heldAlerts');
  });

  it('non-admins see only the error category; admins see the redacted text', async () => {
    const h = await setup();
    const u = addUser(h.db);
    const d = h.personal.create(u.id, dest('broken'));
    h.failing.set('https://hooks.example/broken', new NotificationError('webhook', 'remoteError', 'upstream page with hunter2 inside', { status: 404 }));
    await h.personal.dispatch(u.id, 'requestApproved', approved(u.id));
    const [own] = h.personal.deliveries(u.id, d.id, false);
    expect(own?.error).toBe(publicError('remoteError'));
    const [adminView] = h.personal.deliveries(u.id, d.id, true);
    expect(adminView?.error).toContain('upstream page');
    expect(adminView?.error).not.toContain('hunter2');
    expect(h.personal.list(u.id, false)[0]?.status.lastError).toBe(publicError(undefined));
    const test = await h.personal.test(u.id, { ...dest('broken'), id: d.id, settings: { ...d.settings } }, false);
    expect(test).toMatchObject({ ok: false, code: 'remoteError', message: 'The service answered with an error (HTTP 404)' });
    expect(h.personal.deliveries(u.id, d.id)[0]).toMatchObject({ test: true, state: 'failed' });
  });

  it('imports of watchlist titles reach the watchers through the system dispatcher', async () => {
    const h = await setup();
    const alice = addUser(h.db);
    const bob = addUser(h.db);
    h.personal.create(alice.id, dest('alice'));
    h.personal.create(bob.id, dest('bob'));
    watch(h.db, alice.id, 603);
    watch(h.db, bob.id, 603, 'series');
    await h.system.dispatch(imported(603));
    expect(h.sent.map((s) => [s.url, s.event.type])).toEqual([['https://hooks.example/alice', 'import']]);
    await h.system.dispatch({ ...imported(603), type: 'upgrade' } as unknown as NotificationEvent);
    expect(h.sent).toHaveLength(1);
  });
});

describe('host checks', () => {
  it('recognises local addresses and names', () => {
    for (const host of ['10.0.0.1', '172.16.5.4', '169.254.1.1', '127.0.0.1', 'fd12:3456::1', 'fe80::1', '::ffff:192.168.0.1', 'router', 'box.home.arpa']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ['ntfy.sh', '8.8.8.8', '172.32.0.1', 'hooks.example.com', '2606:4700:4700::1111']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
    expect(privateTarget({ host: '192.168.0.2', port: 8080 })).toBe('192.168.0.2');
    expect(privateTarget({ urls: ['ntfys://ntfy.sh/topic', 'json://10.1.1.1/x'] })).toBe('10.1.1.1');
    expect(privateTarget({ url: 'https://ntfy.sh/x' })).toBeUndefined();
  });

  it('catches every IPv4-in-IPv6 and shorthand spelling (DATA-01, DATA-42)', () => {
    for (const host of [
      '[::ffff:7f00:1]',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:7f00:1',
      '::127.0.0.1',
      '64:ff9b::7f00:1',
      'fec0::1',
      '198.18.0.1',
      '127.1',
      '0x7f.1',
      '0177.0.0.1',
      '2001:db8::1',
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    expect(privateTarget({ url: 'http://[::ffff:127.0.0.1]:8080/api' })).toBeDefined();
    expect(privateTarget({ url: 'http://0x7f.1/' })).toBeDefined();
  });
});

describe('default agents send through the safe fetch (DATA-01, DATA-42)', () => {
  async function loopbackStub() {
    const http = await import('node:http');
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { port, hits: () => hits, close: () => new Promise((r) => server.close(r)) };
  }

  it('a destination saved while admin cannot reach the LAN once the owner is demoted', async () => {
    const db = await createTestDb({ ...tables, ...requestsSchema });
    const personal = new PersonalNotifications({ db, log, now: () => new Date(NOW), sleep: async () => {} });
    const stub = await loopbackStub();
    try {
      const admin = addUser(db, { username: 'boss', role: 'admin' });
      const created = personal.create(admin.id, dest('lan', { events: ['requestApproved'] }, { url: `http://127.0.0.1:${stub.port}/hook` }));
      expect(created.id).toBeGreaterThan(0);
      db.update((await import('../auth/schema.js')).users).set({ role: 'user', permissions: 0 }).run();
      const outcomes = await personal.dispatch(admin.id, 'requestApproved', approved(admin.id));
      expect(outcomes[0]?.ok).toBe(false);
      expect(stub.hits()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('a non-admin test send to a mapped-IPv6 loopback URL is refused before any request', async () => {
    const db = await createTestDb({ ...tables, ...requestsSchema });
    const personal = new PersonalNotifications({ db, log, now: () => new Date(NOW), sleep: async () => {} });
    const stub = await loopbackStub();
    try {
      const user = addUser(db, { username: 'pat' });
      await expect(
        personal.test(user.id, dest('x', {}, { url: `http://[::ffff:127.0.0.1]:${stub.port}/hook` }), false),
      ).rejects.toThrow(/local network address/);
      expect(stub.hits()).toBe(0);
    } finally {
      await stub.close();
    }
  });
});

describe('request notifier hook', () => {
  it('request approval calls the personal dispatcher for the requester', async () => {
    const calls: Array<[number, string, string]> = [];
    const h = await requestsSetup({
      extra: {
        personalDispatch: async (userId, key, event) => {
          calls.push([userId, key, event.type]);
        },
      },
    });
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const admin = addUser(h.db, { role: 'admin' });
    const u = addUser(h.db);
    const created = await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    if (created.kind !== 'created') throw new Error('not created');
    await h.services.requests.approve(admin.actor, created.request.id);
    expect(calls).toContainEqual([u.id, 'requestApproved', 'requestApproved']);
  });
});

describe('personal destination routes', () => {
  async function build() {
    const db = await createTestDb({ ...tables, ...requestsSchema });
    const ctx = makeContext(db);
    const admin = addUser(db, { role: 'admin', username: 'owner' });
    const alice = addUser(db, { username: 'alice' });
    const bob = addUser(db, { username: 'bob' });
    const service = new NotificationsService({ db, log });
    const personal = new PersonalNotifications({ db, log, sleep: async () => {} });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(
      async (api) => {
        installAuth(api, ctx);
        await api.register(notificationsRoutes(service, personal));
      },
      { prefix: '/api/v1' },
    );
    await app.ready();
    const auth = authServiceFor(ctx);
    const cookie = (id: number) => ({ cookie: `${SESSION_COOKIE}=${auth.createSession(id).token}` });
    return { app, admin, alice, bob, cookie };
  }

  it('users manage their own destinations; others get 403, admins may manage anyone', async () => {
    const { app, admin, alice, bob, cookie } = await build();
    const url = `/api/v1/user/${alice.id}/notification-destination`;
    const created = await app.inject({ method: 'POST', url, headers: cookie(alice.id), payload: dest('phone') });
    expect(created.statusCode).toBe(201);
    expect(created.json().settings.password).toBe(NOTIFICATION_SECRET_MASK);
    expect((await app.inject({ method: 'GET', url, headers: cookie(alice.id) })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url, headers: cookie(bob.id) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url, headers: cookie(admin.id) })).json()).toHaveLength(1);
    const options = await app.inject({ method: 'GET', url: `${url}/options`, headers: cookie(alice.id) });
    expect(options.json()).toMatchObject({ enabled: true });
    expect(options.json().schemas.length).toBeGreaterThan(10);
    const lan = await app.inject({ method: 'POST', url, headers: cookie(alice.id), payload: dest('lan', {}, { url: 'http://192.168.0.9/x' }) });
    expect(lan.statusCode).toBe(400);
    const id = created.json().id as number;
    const log = await app.inject({ method: 'GET', url: `${url}/${id}/deliveries`, headers: cookie(alice.id) });
    expect(log.statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `${url}/${id}`, headers: cookie(bob.id) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `${url}/${id}`, headers: cookie(alice.id) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('portal users may read the template variables and render previews', async () => {
    const { app, alice, cookie } = await build();
    expect((await app.inject({ method: 'GET', url: '/api/v1/notification/templates', headers: cookie(alice.id) })).statusCode).toBe(200);
    const preview = await app.inject({ method: 'POST', url: '/api/v1/notification/preview', headers: cookie(alice.id), payload: { eventType: 'requestApproved' } });
    expect(preview.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notification', headers: cookie(alice.id) })).statusCode).toBe(403);
  });
});
