import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  createAgent,
  NotificationError,
  type MediaInfo,
  type NotificationAgentKind,
  type NotificationEvent,
} from '@arclight/notifications';
import { NOTIFICATION_SECRET_MASK, type NotificationInputRaw } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { downloadClients, movies, series, trackedDownloads } from '../../db/schema.js';
import { EventBus } from '../../events.js';
import { attachNotificationBus } from './index.js';
import { notificationsRoutes } from './routes.js';
import * as tables from './schema.js';
import { NotificationsError, NotificationsService } from './service.js';
import { insertEpisode, insertFile, insertMovie, insertSeries, insertTag } from './test-support.js';
import { EventTranslator } from './translate.js';

const log = pino({ level: 'silent' });

interface Sent {
  kind: NotificationAgentKind;
  settings: Record<string, unknown>;
  event: NotificationEvent;
}

async function setup() {
  const db = await createTestDb({ ...tables });
  const sent: Sent[] = [];
  /** Webhook URLs whose agent throws on send. */
  const failing = new Set<string>();
  const service = new NotificationsService({
    db,
    log,
    now: () => new Date('2026-03-01T12:00:00Z'),
    agentFactory: (kind, settings) => {
      const real = createAgent(kind, settings); // validates and gives the real capabilities
      return {
        kind,
        supportedEvents: real.supportedEvents,
        async send(event) {
          const s = settings as Record<string, unknown>;
          if (typeof s['url'] === 'string' && failing.has(s['url'])) {
            throw new NotificationError(kind, 'network', 'connection refused');
          }
          sent.push({ kind, settings: s, event });
        },
        async test() {},
      };
    },
  });
  return { db, service, sent, failing };
}

const webhook = (name: string, extra: Partial<NotificationInputRaw> = {}, settings: Record<string, unknown> = {}): NotificationInputRaw => ({
  name,
  implementation: 'webhook',
  settings: { url: `https://hooks.example/${name}`, password: 'hunter2', headers: { 'X-Api-Key': 'k-123' }, ...settings },
  ...extra,
});

const base = { instanceName: 'Arclight', timestamp: '2026-03-01T12:00:00Z' };

function media(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    id: 1,
    mediaType: 'series',
    title: 'Show',
    year: 2024,
    tmdbId: 1,
    path: '/tv/Show',
    genres: [],
    tags: [],
    images: [],
    ...overrides,
  };
}

const grab = (m: MediaInfo = media()): NotificationEvent => ({
  ...base,
  type: 'grab',
  media: m,
  release: { title: 'Show.S01E01', quality: 'WEBDL-1080p', qualityVersion: 1, size: 1, customFormats: [], customFormatScore: 0 },
});

const healthEvent = (status: 'warning' | 'error', type: 'healthIssue' | 'healthRestored' = 'healthIssue'): NotificationEvent => ({
  ...base,
  type,
  health: { source: 'X', status, message: 'something' },
});

// ---------------------------------------------------------------------------------------
// CRUD and masking
// ---------------------------------------------------------------------------------------

describe('notifications CRUD', () => {
  it('masks secrets on read but stores them unmasked', async () => {
    const { db, service } = await setup();
    const created = service.create(webhook('Hook', { onGrab: true }));
    expect(created.settings['password']).toBe(NOTIFICATION_SECRET_MASK);
    expect(created.settings['headers']).toEqual({ 'X-Api-Key': NOTIFICATION_SECRET_MASK });
    expect(created.settings['url']).toBe('https://hooks.example/Hook');
    expect(JSON.stringify(service.list())).not.toContain('hunter2');
    const row = db.select().from(tables.notifications).get();
    expect(row?.settings['password']).toBe('hunter2');
    expect(row?.settings['method']).toBe('POST'); // agent schema defaults applied
  });

  it('keeps stored secrets when the masked value is sent back, replaces them otherwise', async () => {
    const { db, service } = await setup();
    const created = service.create(webhook('Hook'));
    service.update(created.id, { ...webhook('Hook'), settings: { ...created.settings } });
    let row = db.select().from(tables.notifications).get();
    expect(row?.settings['password']).toBe('hunter2');
    expect(row?.settings['headers']).toEqual({ 'X-Api-Key': 'k-123' });
    service.update(created.id, webhook('Hook', {}, { password: 'new-pass' }));
    row = db.select().from(tables.notifications).get();
    expect(row?.settings['password']).toBe('new-pass');
  });

  it('masks Telegram bot tokens and Discord webhook URLs', async () => {
    const { service } = await setup();
    const tg = service.create({ name: 'TG', implementation: 'telegram', settings: { botToken: 'abc:def', chatId: '-100' } });
    expect(tg.settings['botToken']).toBe(NOTIFICATION_SECRET_MASK);
    expect(tg.settings['chatId']).toBe('-100');
    const dc = service.create({ name: 'DC', implementation: 'discord', settings: { webhookUrl: 'https://discord.com/api/webhooks/1/secret' } });
    expect(dc.settings['webhookUrl']).toBe(NOTIFICATION_SECRET_MASK);
  });

  it('rejects invalid settings, duplicate names and unknown ids with typed errors', async () => {
    const { service } = await setup();
    expect(() => service.create({ name: 'Bad', implementation: 'webhook', settings: { url: 'not a url' } })).toThrow(NotificationsError);
    service.create(webhook('Hook'));
    expect(() => service.create(webhook('hook'))).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => service.get(99)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => service.delete(99)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('derives supportsOn* flags from the agent and stores unsupported triggers as off', async () => {
    const { service } = await setup();
    const plex = service.create({
      name: 'Plex',
      implementation: 'plex',
      onGrab: true,
      onDownload: true,
      settings: { host: 'plex', authToken: 't' },
    });
    expect(plex.supportsOnGrab).toBe(false);
    expect(plex.supportsOnDownload).toBe(true);
    expect(plex.supportsOnRename).toBe(true);
    expect(plex.onGrab).toBe(false);
    expect(plex.onDownload).toBe(true);
    expect(plex.settings['authToken']).toBe(NOTIFICATION_SECRET_MASK);

    const emby = service.create({ name: 'Emby', implementation: 'emby', settings: { host: 'emby', apiKey: 'k', notify: true } });
    expect(emby.supportsOnGrab).toBe(true);
    const discord = service.create({ name: 'D', implementation: 'discord', onRename: true, settings: { webhookUrl: 'https://d.example/x' } });
    expect(discord.supportsOnRename).toBe(false);
    expect(discord.onRename).toBe(false);
  });

  it('deletes connections', async () => {
    const { service } = await setup();
    const c = service.create(webhook('Hook'));
    service.delete(c.id);
    expect(service.list()).toEqual([]);
  });
});

describe('notification schema', () => {
  it('lists every agent kind with fields generated from the Zod settings schemas', async () => {
    const { service } = await setup();
    const schemas = service.schemas();
    expect(schemas.map((s) => s.implementation)).toHaveLength(11);
    const discord = schemas.find((s) => s.implementation === 'discord')!;
    const url = discord.fields.find((f) => f.name === 'webhookUrl')!;
    expect(url).toMatchObject({ type: 'url', required: true, secret: true });
    expect(url.helpText).toContain('Discord channel webhook URL');
    const grabFields = discord.fields.find((f) => f.name === 'grabFields')!;
    expect(grabFields.type).toBe('multiSelect');
    expect(grabFields.options?.length).toBeGreaterThan(5);

    const email = schemas.find((s) => s.implementation === 'email')!;
    expect(email.fields.find((f) => f.name === 'port')).toMatchObject({ type: 'number', default: 587, min: 1, max: 65535 });
    expect(email.fields.find((f) => f.name === 'security')?.options?.map((o) => o.value)).toEqual(['none', 'starttls', 'tls']);
    expect(email.fields.find((f) => f.name === 'password')).toMatchObject({ type: 'password', secret: true });
    expect(email.fields.find((f) => f.name === 'to')?.type).toBe('emailList');
    expect(email.template.settings['subjectPrefix']).toBe('[Arclight]');

    const plex = schemas.find((s) => s.implementation === 'plex')!;
    expect(plex.supportsOnGrab).toBe(false);
    expect(plex.template.onGrab).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Test sends
// ---------------------------------------------------------------------------------------

describe('notification test', () => {
  it('sends a test event and reports failures with the agent error code', async () => {
    const { service, sent, failing } = await setup();
    expect(await service.test(webhook('Hook'))).toEqual({ ok: true });
    expect(sent[0]?.event.type).toBe('test');
    failing.add('https://hooks.example/Down');
    const result = await service.test(webhook('Down'));
    expect(result).toMatchObject({ ok: false, code: 'network', message: 'connection refused' });
  });

  it('restores masked secrets from the saved connection when testing by id', async () => {
    const { service, sent } = await setup();
    const c = service.create(webhook('Hook'));
    await service.test({ ...webhook('Hook'), id: c.id, settings: { ...c.settings } });
    expect(sent[0]?.settings['password']).toBe('hunter2');
  });

  it('testAll covers enabled connections only', async () => {
    const { service } = await setup();
    service.create(webhook('A'));
    service.create(webhook('B', { enabled: false }));
    const results = await service.testAll();
    expect(results.map((r) => r.name)).toEqual(['A']);
  });
});

// ---------------------------------------------------------------------------------------
// Dispatch filtering
// ---------------------------------------------------------------------------------------

describe('dispatch', () => {
  it('routes by trigger flag and skips disabled connections', async () => {
    const { service, sent } = await setup();
    service.create(webhook('Grabs', { onGrab: true }));
    service.create(webhook('Imports', { onDownload: true }));
    service.create(webhook('Off', { onGrab: true, enabled: false }));
    const outcomes = await service.dispatch(grab());
    expect(outcomes.map((o) => o.name)).toEqual(['Grabs']);
    expect(sent).toHaveLength(1);
  });

  it('uses the series or movie flag for added/deleted events', async () => {
    const { service } = await setup();
    service.create(webhook('Series', { onSeriesAdd: true, onSeriesDelete: true }));
    service.create(webhook('Movies', { onMovieAdd: true }));
    const added = await service.dispatch({ ...base, type: 'mediaAdded', media: media({ mediaType: 'movie' }), addMethod: 'manual' });
    expect(added.map((o) => o.name)).toEqual(['Movies']);
    const deleted = await service.dispatch({ ...base, type: 'mediaDeleted', media: media(), deletedFiles: false });
    expect(deleted.map((o) => o.name)).toEqual(['Series']);
  });

  it('sends health errors always and warnings only with includeHealthWarnings', async () => {
    const { service } = await setup();
    service.create(webhook('ErrorsOnly', { onHealthIssue: true, onHealthRestored: true }));
    service.create(webhook('Everything', { onHealthIssue: true, includeHealthWarnings: true }));
    expect((await service.dispatch(healthEvent('error'))).map((o) => o.name)).toEqual(['ErrorsOnly', 'Everything']);
    expect((await service.dispatch(healthEvent('warning'))).map((o) => o.name)).toEqual(['Everything']);
    expect((await service.dispatch(healthEvent('error', 'healthRestored'))).map((o) => o.name)).toEqual(['ErrorsOnly']);
  });

  it('filters media events by tag label; non-media events ignore tags', async () => {
    const { db, service } = await setup();
    const anime = insertTag(db, 'anime');
    insertTag(db, 'kids');
    service.create(webhook('AnimeOnly', { onGrab: true, onHealthIssue: true, tags: [anime] }));
    service.create(webhook('All', { onGrab: true }));
    expect((await service.dispatch(grab(media({ tags: ['kids'] })))).map((o) => o.name)).toEqual(['All']);
    expect((await service.dispatch(grab(media({ tags: ['anime'] })))).map((o) => o.name)).toEqual(['AnimeOnly', 'All']);
    expect((await service.dispatch(healthEvent('error'))).map((o) => o.name)).toEqual(['AnimeOnly']);
  });

  it('isolates a failing connection and records its failure', async () => {
    const { service, sent, failing } = await setup();
    const bad = service.create(webhook('Bad', { onGrab: true }));
    service.create(webhook('Good', { onGrab: true }));
    failing.add('https://hooks.example/Bad');
    const outcomes = await service.dispatch(grab());
    expect(outcomes).toEqual([
      { id: bad.id, name: 'Bad', ok: false, error: 'connection refused' },
      expect.objectContaining({ name: 'Good', ok: true }),
    ]);
    expect(sent.map((s) => s.settings['url'])).toEqual(['https://hooks.example/Good']);
    expect(service.connectionStatuses().get(bad.id)).toMatchObject({ consecutiveFailures: 1, lastError: 'connection refused' });
  });

  it('never sends an event the agent does not support', async () => {
    const { service, sent } = await setup();
    service.create({ name: 'Plex', implementation: 'plex', onDownload: true, onHealthIssue: true, settings: { host: 'p', authToken: 't' } });
    expect(await service.dispatch(healthEvent('error'))).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('reports enabled connections whose stored settings no longer validate', async () => {
    const { db, service } = await setup();
    const c = service.create(webhook('Hook', { onGrab: true }));
    db.update(tables.notifications).set({ settings: { url: 'broken' } }).run();
    expect(service.misconfigured()).toEqual([expect.objectContaining({ id: c.id, name: 'Hook' })]);
    const outcomes = await service.dispatch(grab());
    expect(outcomes[0]?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Bus translation
// ---------------------------------------------------------------------------------------

describe('bus translation', () => {
  it('turns health snapshots into issue/restored edges only', async () => {
    const { db } = await setup();
    const t = new EventTranslator({ db });
    const warn = { source: 'IndexerCheck', status: 'error' as const, message: 'No indexers' };
    const first = t.translate({ type: 'health', health: { status: 'error', checks: [warn] } });
    expect(first).toEqual([expect.objectContaining({ type: 'healthIssue', health: warn })]);
    expect(t.translate({ type: 'health', health: { status: 'error', checks: [warn] } })).toEqual([]);
    const restored = t.translate({ type: 'health', health: { status: 'ok', checks: [] } });
    expect(restored).toEqual([expect.objectContaining({ type: 'healthRestored', health: warn })]);
  });

  it('holds health notifications back during the startup grace period', async () => {
    const { db } = await setup();
    let now = new Date('2026-03-01T00:00:00Z');
    const t = new EventTranslator({ db, now: () => now, healthGraceUntil: new Date('2026-03-01T00:15:00Z') });
    const check = { source: 'DownloadClientCheck', status: 'error' as const, message: 'down' };
    expect(t.translate({ type: 'health', health: { status: 'error', checks: [check] } })).toEqual([]);
    now = new Date('2026-03-01T00:16:00Z');
    expect(t.translate({ type: 'health', health: { status: 'error', checks: [check] } })).toHaveLength(1);
  });

  it('builds mediaAdded with tag labels and absolute images, and remembers media for deletion', async () => {
    const { db } = await setup();
    const tag = insertTag(db, 'anime');
    const s = insertSeries(db, { tags: [tag] });
    const t = new EventTranslator({ db });
    const [added] = t.translate({ type: 'library', action: 'added', mediaType: 'series', id: s.id });
    expect(added).toMatchObject({
      type: 'mediaAdded',
      addMethod: 'manual',
      media: { id: s.id, mediaType: 'series', title: 'Example Show', tvdbId: 7000, tags: ['anime'], rating: 8.1 },
    });
    expect(added && 'media' in added ? added.media?.images : []).toEqual([{ coverType: 'poster', url: 'https://img.example/p.jpg' }]);

    db.delete(series).run();
    const [deleted] = t.translate({ type: 'library', action: 'deleted', mediaType: 'series', id: s.id });
    expect(deleted).toMatchObject({ type: 'mediaDeleted', media: { title: 'Example Show' }, deletedFiles: false });
    // Unknown and gone: nothing to say.
    expect(t.translate({ type: 'library', action: 'deleted', mediaType: 'movie', id: 999 })).toEqual([]);
  });

  it('enriches release grabbed from the tracked download (episodes, client, release snapshot)', async () => {
    const { db } = await setup();
    const s = insertSeries(db);
    const e1 = insertEpisode(db, s.id, { episodeNumber: 1 });
    const e2 = insertEpisode(db, s.id, { episodeNumber: 2 });
    const client = db
      .insert(downloadClients)
      .values({ name: 'qBit', implementation: 'qbittorrent', protocol: 'torrent', tags: [], settings: {}, updatedAt: 'x' })
      .returning()
      .get();
    db.insert(trackedDownloads)
      .values({
        downloadId: 'HASH',
        clientId: client.id,
        title: 'Show.S01E01E02.1080p',
        state: 'downloading',
        statusMessages: [],
        protocol: 'torrent',
        size: 4242,
        addedAt: 'x',
        updatedAt: 'x',
        mediaType: 'series',
        seriesId: s.id,
        episodeIds: [e2.id, e1.id],
        grabbedRelease: { indexer: 'Nyaa', quality: { quality: { name: 'WEBDL-1080p' }, revision: { version: 2 } }, customFormats: [{ name: 'x265' }] },
      })
      .run();
    const t = new EventTranslator({ db });
    const [ev] = t.translate({ type: 'release', action: 'grabbed', title: 'Show.S01E01E02.1080p' });
    expect(ev).toMatchObject({
      type: 'grab',
      media: { id: s.id },
      downloadClient: 'qBit',
      downloadClientType: 'qbittorrent',
      downloadId: 'HASH',
      release: { quality: 'WEBDL-1080p', qualityVersion: 2, indexer: 'Nyaa', size: 4242, customFormats: ['x265'] },
    });
    expect(ev && ev.type === 'grab' ? ev.episodes?.map((e) => e.episodeNumber) : []).toEqual([1, 2]);
  });

  it('builds import events from the newest media file and its episodes', async () => {
    const { db } = await setup();
    const m = insertMovie(db);
    const file = insertFile(db, { mediaType: 'movie', movieId: m.id, relativePath: 'Movie.mkv' });
    db.update(movies).set({ movieFileId: file.id, hasFile: true }).run();
    const t = new EventTranslator({ db });
    const [ev] = t.translate({ type: 'import', action: 'imported', title: 'x', mediaType: 'movie', mediaId: m.id });
    expect(ev).toMatchObject({
      type: 'import',
      media: { mediaType: 'movie', imdbId: 'tt0000001' },
      file: { id: file.id, quality: 'WEBDL-1080p', qualityVersion: 2, releaseGroup: 'GRP', mediaInfo: { width: 1920, height: 1080 } },
    });

    const s = insertSeries(db);
    const sf = insertFile(db, { mediaType: 'series', seriesId: s.id, seasonNumber: 1 });
    insertEpisode(db, s.id, { episodeFileId: sf.id, hasFile: true });
    const [sev] = t.translate({ type: 'import', action: 'imported', title: 'x', mediaType: 'series', mediaId: s.id });
    expect(sev && sev.type === 'import' ? sev.episodes?.length : 0).toBe(1);
  });

  it('translates manual interaction and ignores events without a mapping', async () => {
    const { db } = await setup();
    const t = new EventTranslator({ db });
    const [ev] = t.translate({ type: 'import', action: 'manualRequired', title: 'Weird.Release', message: 'No files found' });
    expect(ev).toMatchObject({
      type: 'manualInteractionRequired',
      downloadTitle: 'Weird.Release',
      statusMessages: [{ title: 'Weird.Release', messages: ['No files found'] }],
    });
    expect(t.translate({ type: 'queue', action: 'changed' })).toEqual([]);
    expect(t.translate({ type: 'release', action: 'grabbed', title: 'unknown' })).toEqual([]);
  });

  it('dispatches translated bus events without blocking the publisher', async () => {
    const { db, service, sent } = await setup();
    service.create(webhook('Hook', { onMovieAdd: true }));
    const m = insertMovie(db);
    const bus = new EventBus();
    const stop = attachNotificationBus({ bus, log }, service, new EventTranslator({ db }));
    bus.publish({ type: 'library', action: 'added', mediaType: 'movie', id: m.id });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.map((s) => s.event.type)).toEqual(['mediaAdded']);
    stop();
    bus.publish({ type: 'library', action: 'added', mediaType: 'movie', id: m.id });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------

describe('notification routes', () => {
  async function build() {
    const ctx = await setup();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(notificationsRoutes(ctx.service), { prefix: '/api/v1' });
    return { ...ctx, app };
  }

  it('serves CRUD with masked secrets and maps errors to status codes', async () => {
    const { app } = await build();
    const created = await app.inject({ method: 'POST', url: '/api/v1/notification', payload: webhook('Hook', { onGrab: true }) });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Hook', onGrab: true, supportsOnGrab: true });
    const list = await app.inject({ method: 'GET', url: '/api/v1/notification' });
    expect(JSON.stringify(list.json())).not.toContain('hunter2');
    const id = created.json().id as number;
    const updated = await app.inject({ method: 'PUT', url: `/api/v1/notification/${id}`, payload: webhook('Renamed') });
    expect(updated.json().name).toBe('Renamed');
    expect((await app.inject({ method: 'POST', url: '/api/v1/notification', payload: webhook('Renamed') })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notification/999' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/notification', payload: { name: 'x', implementation: 'nope' } })).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/notification/${id}` })).statusCode).toBe(204);
  });

  it('serves schema, test and testall', async () => {
    const { app } = await build();
    const schema = await app.inject({ method: 'GET', url: '/api/v1/notification/schema' });
    expect(schema.statusCode).toBe(200);
    expect(schema.json()).toHaveLength(11);
    const test = await app.inject({ method: 'POST', url: '/api/v1/notification/test', payload: webhook('Hook') });
    expect(test.json()).toEqual({ ok: true });
    await app.inject({ method: 'POST', url: '/api/v1/notification', payload: webhook('Hook') });
    const all = await app.inject({ method: 'POST', url: '/api/v1/notification/testall' });
    expect(all.json()).toEqual([expect.objectContaining({ name: 'Hook', ok: true })]);
  });
});
