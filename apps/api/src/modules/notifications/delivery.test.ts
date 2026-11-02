import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createAgent, NotificationError, type MediaInfo, type NotificationEvent } from '@arclight/notifications';
import { NOTIFICATION_SECRET_MASK, type NotificationInputRaw, type QuietHoursSettings } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { backoffMs, isRetryable, passesFilters, RateLimiter, sendWithRetry } from './delivery.js';
import { notificationsRoutes } from './routes.js';
import * as tables from './schema.js';
import { NotificationsError, NotificationsService, normalizeTemplates, previewTemplate } from './service.js';

// Delivery reliability: retries with backoff, the per-connection delivery log, rate limits,
// per-connection quiet hours, filters, templates and redaction.

const log = pino({ level: 'silent' });

/** A one-hour quiet window around `at` (local time), so tests do not depend on the time zone. */
function quietAround(at: Date): QuietHoursSettings {
  const h = at.getHours();
  const pad = (n: number) => String(n % 24).padStart(2, '0');
  return { enabled: true, start: `${pad(h)}:00`, end: `${pad(h + 1)}:00`, days: [0, 1, 2, 3, 4, 5, 6] };
}

async function setup() {
  const db = await createTestDb({ ...tables });
  let clock = new Date('2026-03-01T12:00:00Z');
  const sleeps: number[] = [];
  const sent: Array<{ url: string; event: NotificationEvent }> = [];
  /** Errors thrown (in order) by the agent with that URL before it starts succeeding. */
  const failures = new Map<string, NotificationError[]>();
  const service = new NotificationsService({
    db,
    log,
    now: () => clock,
    quietHours: () => ({ enabled: false, start: '22:00', end: '07:00', days: [] }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    agentFactory: (kind, settings, templates) => {
      const real = createAgent(kind, settings, templates ? { templates } : {});
      const url = String((settings as Record<string, unknown>)['url']);
      return {
        kind,
        supportedEvents: real.supportedEvents,
        async send(event) {
          const queue = failures.get(url);
          const next = queue?.shift();
          if (next) throw next;
          sent.push({ url, event });
        },
        async test() {},
      };
    },
  });
  return {
    db,
    service,
    sent,
    sleeps,
    failures,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => clock,
  };
}

const hook = (name: string, extra: Partial<NotificationInputRaw> = {}, settings: Record<string, unknown> = {}): NotificationInputRaw => ({
  name,
  implementation: 'webhook',
  onGrab: true,
  respectQuietHours: true,
  settings: { url: `https://hooks.example/${name}`, password: 'hunter2', ...settings },
  ...extra,
});

function media(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return { id: 1, mediaType: 'series', title: 'Show', year: 2024, tmdbId: 1, path: '/tv/Show', genres: [], tags: [], images: [], ...overrides };
}

const grab = (m: MediaInfo = media(), quality = 'WEBDL-1080p'): NotificationEvent => ({
  instanceName: 'Arclight',
  timestamp: '2026-03-01T12:00:00Z',
  type: 'grab',
  media: m,
  release: { title: 'Show.S01E01', quality, qualityVersion: 1, size: 1, customFormats: [], customFormatScore: 0 },
});

describe('sendWithRetry', () => {
  it('retries retryable failures with doubling backoff and reports the attempts', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await sendWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw new NotificationError('webhook', 'network', 'refused');
      },
      { maxAttempts: 5, sleep: async (ms) => void sleeps.push(ms), redact: (t) => t },
    );
    expect(result).toEqual({ ok: true, attempts: 3 });
    expect(sleeps).toEqual([2000, 4000]);
  });

  it('stops at maxAttempts and redacts the last error', async () => {
    const result = await sendWithRetry(
      async () => {
        throw new NotificationError('webhook', 'remoteError', 'token s3cret rejected', { status: 502 });
      },
      { maxAttempts: 2, sleep: async () => {}, redact: (t) => t.replace('s3cret', '***') },
    );
    expect(result).toMatchObject({ ok: false, attempts: 2, error: 'token *** rejected', code: 'remoteError', status: 502 });
  });

  it('does not retry bad settings, auth failures or 4xx answers', async () => {
    for (const err of [
      new NotificationError('webhook', 'unauthorized', 'no'),
      new NotificationError('webhook', 'invalidSettings', 'no'),
      new NotificationError('webhook', 'remoteError', 'no', { status: 400 }),
      new Error('plain'),
    ]) {
      let calls = 0;
      const result = await sendWithRetry(
        async () => {
          calls++;
          throw err;
        },
        { maxAttempts: 4, sleep: async () => {}, redact: (t) => t },
      );
      expect(result.ok).toBe(false);
      expect(calls).toBe(1);
    }
    expect(isRetryable(new NotificationError('webhook', 'remoteError', 'x'))).toBe(true);
    expect(isRetryable(new NotificationError('webhook', 'timeout', 'x'))).toBe(true);
  });

  it('backs off longer after a rate limit and caps at a minute', () => {
    const limited = new NotificationError('webhook', 'rateLimited', 'slow down');
    expect(backoffMs(1, limited)).toBe(5000);
    expect(backoffMs(2, limited)).toBe(10000);
    expect(backoffMs(10, new Error('x'))).toBe(60000);
  });
});

describe('RateLimiter', () => {
  it('admits `limit` messages per sliding minute; 0 is unlimited', () => {
    const limiter = new RateLimiter();
    expect(limiter.take('a', 2, 0)).toBe(true);
    expect(limiter.take('a', 2, 1000)).toBe(true);
    expect(limiter.take('a', 2, 2000)).toBe(false);
    expect(limiter.hasRoom('a', 2, 59_999)).toBe(false);
    expect(limiter.hasRoom('a', 2, 60_001)).toBe(true);
    expect(limiter.take('b', 0, 0) && limiter.take('b', 0, 0) && limiter.take('b', 0, 0)).toBe(true);
    limiter.forget('a');
    expect(limiter.hasRoom('a', 2, 2000)).toBe(true);
  });
});

describe('passesFilters', () => {
  const filters = (f: Partial<{ mediaTypes: ('series' | 'movie' | 'music' | 'audiobook')[]; qualities: string[]; users: number[] }>) => ({
    mediaTypes: [],
    qualities: [],
    users: [],
    ...f,
  });

  it('filters by media kind and by quality, case-insensitively', () => {
    expect(passesFilters(filters({ mediaTypes: ['movie'] }), grab())).toBe(false);
    expect(passesFilters(filters({ mediaTypes: ['series'] }), grab())).toBe(true);
    expect(passesFilters(filters({ qualities: ['webdl-1080p'] }), grab())).toBe(true);
    expect(passesFilters(filters({ qualities: ['Bluray-2160p'] }), grab())).toBe(false);
  });

  it('filters by requesting user and lets events it cannot judge through', () => {
    const approved = { type: 'requestApproved', request: { requestedBy: { id: 7 } } } as unknown as NotificationEvent;
    expect(passesFilters(filters({ users: [7] }), approved)).toBe(true);
    expect(passesFilters(filters({ users: [8] }), approved)).toBe(false);
    const health = { type: 'healthIssue', health: { source: 'x', status: 'error', message: 'm' } } as unknown as NotificationEvent;
    expect(passesFilters(filters({ mediaTypes: ['movie'], users: [8], qualities: ['x'] }), health)).toBe(true);
    expect(passesFilters(null, grab())).toBe(true);
  });
});

describe('dispatch reliability', () => {
  it('retries a flaky connection and logs one sent delivery with the attempts', async () => {
    const h = await setup();
    const conn = h.service.create(hook('flaky', { maxAttempts: 4 }));
    h.failures.set('https://hooks.example/flaky', [
      new NotificationError('webhook', 'timeout', 'slow'),
      new NotificationError('webhook', 'network', 'refused'),
    ]);
    const [outcome] = await h.service.dispatch(grab());
    expect(outcome).toMatchObject({ ok: true, attempts: 3 });
    expect(h.sleeps).toEqual([2000, 4000]);
    const [entry] = h.service.deliveries(conn.id);
    expect(entry).toMatchObject({ eventType: 'grab', state: 'sent', attempts: 3, test: false });
    expect(entry?.title).toContain('Show');
    expect(h.service.get(conn.id).status).toMatchObject({ consecutiveFailures: 0 });
  });

  it('logs failures with the redacted last error and counts consecutive failures', async () => {
    const h = await setup();
    const conn = h.service.create(hook('down', { maxAttempts: 1 }));
    const fail = () => new NotificationError('webhook', 'unauthorized', 'password hunter2 refused', { status: 401 });
    h.failures.set('https://hooks.example/down', [fail(), fail()]);
    const [outcome] = await h.service.dispatch(grab());
    await h.service.dispatch(grab());
    expect(outcome).toMatchObject({ ok: false, attempts: 1 });
    expect(outcome?.error).not.toContain('hunter2');
    const log = h.service.deliveries(conn.id);
    expect(log.map((d) => d.state)).toEqual(['failed', 'failed']);
    expect(log[0]).toMatchObject({ code: 'unauthorized' });
    expect(JSON.stringify(log)).not.toContain('hunter2');
    const status = h.service.get(conn.id).status;
    expect(status.consecutiveFailures).toBe(2);
    expect(status.lastError).toBeDefined();
    expect(status.lastError).not.toContain('hunter2');
    await h.service.dispatch(grab());
    expect(h.service.get(conn.id).status).toMatchObject({ consecutiveFailures: 0 });
  });

  it('holds what exceeds the rate limit and sends it as one batch once the minute is over', async () => {
    const h = await setup();
    const conn = h.service.create(hook('slow', { rateLimitPerMinute: 2 }));
    h.service.create(hook('fast'));
    for (let i = 0; i < 4; i++) await h.service.dispatch(grab(media({ title: `Show ${i}` })));
    const slow = () => h.sent.filter((s) => s.url.endsWith('/slow'));
    expect(slow()).toHaveLength(2);
    expect(h.sent.filter((s) => s.url.endsWith('/fast'))).toHaveLength(4);
    expect(h.service.deliveries(conn.id).map((d) => d.state)).toEqual(['rateLimited', 'rateLimited', 'sent', 'sent']);
    expect(await h.service.flushHeld()).toBe(0); // still inside the minute
    h.advance(61_000);
    expect(await h.service.flushHeld()).toBe(2);
    const batch = slow()[2]!.event;
    expect(batch.type).toBe('heldAlerts');
    if (batch.type === 'heldAlerts') expect(batch.events.map((e) => (e.type === 'grab' ? e.media.title : ''))).toEqual(['Show 2', 'Show 3']);
    expect(h.service.heldCount()).toBe(0);
  });

  it('per-connection quiet hours hold alerts for that connection only, then flush', async () => {
    const h = await setup();
    const quiet = h.service.create(hook('night', { quietHours: quietAround(h.now()) }));
    h.service.create(hook('day'));
    await h.service.dispatch(grab());
    expect(h.sent.map((s) => s.url)).toEqual(['https://hooks.example/day']);
    expect(h.service.deliveries(quiet.id)[0]).toMatchObject({ state: 'held' });
    expect(await h.service.flushHeld()).toBe(0);
    h.advance(2 * 3600_000);
    expect(await h.service.flushHeld()).toBe(1);
    expect(h.sent.map((s) => s.url)).toEqual(['https://hooks.example/day', 'https://hooks.example/night']);
  });

  it('a connection that ignores quiet hours sends during its own window', async () => {
    const h = await setup();
    h.service.create(hook('night', { quietHours: quietAround(h.now()), respectQuietHours: false }));
    await h.service.dispatch(grab());
    expect(h.sent).toHaveLength(1);
  });

  it('applies the media kind and quality filters per connection', async () => {
    const h = await setup();
    h.service.create(hook('movies', { filters: { mediaTypes: ['movie'] } }));
    h.service.create(hook('uhd', { filters: { qualities: ['Bluray-2160p'] } }));
    h.service.create(hook('all'));
    await h.service.dispatch(grab());
    await h.service.dispatch(grab(media({ mediaType: 'movie' }), 'Bluray-2160p'));
    expect(h.sent.map((s) => `${s.url.split('/').pop()}:${s.event.type === 'grab' ? s.event.media.mediaType : ''}`)).toEqual([
      'all:series',
      'movies:movie',
      'uhd:movie',
      'all:movie',
    ]);
  });

  it('a saved connection logs its tests', async () => {
    const h = await setup();
    const conn = h.service.create(hook('t'));
    const result = await h.service.test({ ...hook('t'), id: conn.id, settings: { ...conn.settings } });
    expect(result.ok).toBe(true);
    expect(h.service.deliveries(conn.id)[0]).toMatchObject({ test: true, state: 'sent', eventType: 'test' });
  });

  it('stores filters, templates and delivery options and validates them', async () => {
    const h = await setup();
    const conn = h.service.create(
      hook('t', {
        filters: { mediaTypes: ['movie'], qualities: [' HDTV-720p ', 'HDTV-720p'], users: [3, 3] },
        templates: { grab: { title: 'Grabbed {{mediaTitle}}', body: '  ' } },
        rateLimitPerMinute: 30,
        maxAttempts: 5,
      }),
    );
    expect(conn).toMatchObject({
      filters: { mediaTypes: ['movie'], qualities: ['HDTV-720p'], users: [3] },
      templates: { grab: { title: 'Grabbed {{mediaTitle}}' } },
      rateLimitPerMinute: 30,
      maxAttempts: 5,
      quietHours: null,
    });
    expect(() => h.service.create(hook('bad', { templates: { grab: { title: '{{#mediaTitle}}open' } } }))).toThrow(NotificationsError);
    expect(() => h.service.create(hook('bad', { templates: { notAnEvent: { title: 'x' } } as never }))).toThrow(/Unknown template event/);
    expect(() => h.service.create(hook('bad', { maxAttempts: 99 }))).toThrow(NotificationsError);
  });
});

describe('templates', () => {
  it('normalizeTemplates drops blanks and rejects unknown keys', () => {
    expect(normalizeTemplates({ default: { title: '', body: 'x' }, grab: { title: ' ' } })).toEqual({ default: { body: 'x' } });
    expect(() => normalizeTemplates({ nope: { title: 'x' } })).toThrow(NotificationsError);
  });

  it('previewTemplate renders a sample event and lists the values', () => {
    const now = new Date('2026-03-01T12:00:00Z');
    const preview = previewTemplate({ eventType: 'grab', template: { title: 'Got {{mediaTitle}}' } }, 'Arclight', now);
    expect(preview.title.startsWith('Got ')).toBe(true);
    expect(preview.error).toBeUndefined();
    expect(Object.keys(preview.values).length).toBeGreaterThan(3);
    const broken = previewTemplate({ eventType: 'grab', template: { title: '{{#mediaTitle}}' } }, 'Arclight', now);
    expect(broken.error).toBeTruthy();
    expect(broken.title).not.toContain('{{');
    expect(() => previewTemplate({ eventType: 'bogus' as never }, 'Arclight', now)).toThrow(NotificationsError);
    expect(previewTemplate({ eventType: 'default' }, 'Arclight', now).subject).toBeTruthy();
  });
});

describe('delivery routes', () => {
  async function build() {
    const h = await setup();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(notificationsRoutes(h.service), { prefix: '/api/v1' });
    return { ...h, app };
  }

  it('serves the delivery log, the template variables and previews', async () => {
    const { app, service } = await build();
    const conn = service.create(hook('h'));
    await service.dispatch(grab());
    const log = await app.inject({ method: 'GET', url: `/api/v1/notification/${conn.id}/deliveries` });
    expect(log.statusCode).toBe(200);
    expect(log.json()).toMatchObject([{ eventType: 'grab', state: 'sent' }]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notification/999/deliveries' })).statusCode).toBe(404);
    const meta = await app.inject({ method: 'GET', url: '/api/v1/notification/templates' });
    expect(meta.json().keys).toContain('default');
    expect(meta.json().variables.length).toBeGreaterThan(5);
    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/notification/preview',
      payload: { eventType: 'import', template: { body: 'Imported {{mediaTitle}}' } },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().body.startsWith('Imported ')).toBe(true);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/notification' });
    expect(listed.json()[0].status).toMatchObject({ consecutiveFailures: 0 });
  });

  it('masks secret list entries (Apprise URLs) and keeps them when sent back masked', async () => {
    const { service, db } = await build();
    const conn = service.create({
      name: 'apprise',
      implementation: 'apprise',
      onGrab: true,
      settings: { serverUrl: 'https://apprise.example', urls: ['tgram://bot-token/chat', 'discord://id/token'] },
    });
    expect(conn.settings['urls']).toEqual([NOTIFICATION_SECRET_MASK, NOTIFICATION_SECRET_MASK]);
    service.update(conn.id, {
      name: 'apprise',
      implementation: 'apprise',
      onGrab: true,
      settings: { ...conn.settings, urls: [NOTIFICATION_SECRET_MASK, 'ntfy://topic'] },
    });
    const row = db.select().from(tables.notifications).get();
    expect(row?.settings['urls']).toEqual(['tgram://bot-token/chat', 'ntfy://topic']);
  });
});
