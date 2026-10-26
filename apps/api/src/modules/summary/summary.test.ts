import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import type { DailySummaryEvent } from '@arclight/notifications';
import { AlertSettings, type DownloadEventType, type HealthCheck } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { dailySummaries, downloadClients, downloadEvents, killSwitchLockdowns, settings, trackedDownloads } from '../../db/schema.js';
import { EventBus } from '../../events.js';
import { summaryRoutes } from './routes.js';
import { SummaryService, summaryCron, SUMMARY_RETENTION_DAYS } from './service.js';

const DAY = 86_400_000;

async function setup(start = '2026-10-26T08:00:00.000Z') {
  const db = await createTestDb({ dailySummaries, downloadClients, downloadEvents, killSwitchLockdowns, settings, trackedDownloads });
  let now = new Date(start);
  const free = new Map<string, number | null>([
    ['/tv', 500e9],
    ['/downloads', 100e9],
  ]);
  const sent: DailySummaryEvent[] = [];
  const issues: HealthCheck[] = [{ source: 'IndexerStatus', status: 'warning', message: 'An indexer is failing' }];
  const changed: unknown[] = [];
  const bus = new EventBus();
  const published: string[] = [];
  bus.subscribe((e) => published.push(e.type));
  const service = new SummaryService({
    db,
    bus,
    now: () => now,
    volumes: async () => [
      { path: '/tv', kind: 'rootFolder' },
      { path: '/downloads', kind: 'download' },
      { path: '/tv', kind: 'rootFolder' },
    ],
    freeSpace: async (path) => free.get(path) ?? null,
    healthIssues: async () => issues,
    notify: async (event) => {
      sent.push(event);
    },
    quietState: () => ({ heldAlerts: 3, quietNow: true }),
    settingsChanged: (s) => changed.push(s),
  });
  const entry = (type: string, time: string, title = 'Show.S01E01', message?: string) =>
    db
      .insert(downloadEvents)
      .values({ trackedDownloadId: 1, downloadId: 'h', title, type: type as DownloadEventType, severity: 'info', time, message: message ?? null })
      .run();
  return { db, service, free, sent, changed, published, entry, setNow: (iso: string) => (now = new Date(iso)) };
}

describe('SummaryService', () => {
  it('counts the last 24 hours of the download timeline', async () => {
    const { db, service, entry, sent, published } = await setup();
    entry('grabbed', '2026-10-25T07:59:00.000Z'); // outside the period
    entry('grabbed', '2026-10-25T09:00:00.000Z');
    entry('grabbed', '2026-10-25T10:00:00.000Z');
    entry('imported', '2026-10-25T12:00:00.000Z');
    entry('importFailed', '2026-10-25T13:00:00.000Z', 'Broken.Movie', 'No video files');
    entry('error', '2026-10-25T14:00:00.000Z');
    entry('stalled', '2026-10-25T15:00:00.000Z');
    entry('recovered', '2026-10-25T16:00:00.000Z');
    entry('releaseReplaced', '2026-10-25T17:00:00.000Z', 'Show.S01E02', 'Swapped for a healthier release');
    db.insert(trackedDownloads)
      .values({ downloadId: 'd1', title: 'Busy.Download', state: 'downloading', statusMessages: [], protocol: 'torrent', progress: 0.4, stateCode: 'stalled', addedAt: 'x', updatedAt: 'x' })
      .run();
    db.insert(trackedDownloads)
      .values({ downloadId: 'd2', title: 'Done', state: 'imported', statusMessages: [], protocol: 'torrent', progress: 1, addedAt: 'x', updatedAt: 'x' })
      .run();

    const summary = await service.generate({ notify: true });
    expect(summary.counts).toEqual({ grabbed: 2, imported: 1, failed: 2, stalled: 1, recovered: 1, replaced: 1 });
    expect(summary.periodStart).toBe('2026-10-25T08:00:00.000Z');
    expect(summary.problems.map((p) => p.type)).toEqual(['releaseReplaced', 'stalled', 'error', 'importFailed']);
    expect(summary.problems[3]).toMatchObject({ title: 'Broken.Movie', message: 'No video files' });
    expect(summary.healthIssues).toHaveLength(1);
    expect(summary.downloading).toEqual({ count: 1, items: [{ id: expect.any(Number), title: 'Busy.Download', progress: 0.4, state: 'stalled' }] });
    // Duplicate volumes are reported once; the first summary has no previous values.
    expect(summary.disk).toEqual([
      { path: '/tv', kind: 'rootFolder', freeBytes: 500e9, changeBytes: null },
      { path: '/downloads', kind: 'download', freeBytes: 100e9, changeBytes: null },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'dailySummary', summary: { id: summary.id } });
    expect(published).toContain('summary');
    expect(service.latest()).toEqual(summary);
  });

  it('reports disk change since the previous summary and keeps 30 days', async () => {
    const { service, free, setNow, sent } = await setup();
    const first = await service.generate();
    expect(sent).toHaveLength(0);
    setNow('2026-10-27T08:00:00.000Z');
    free.set('/tv', 480e9);
    free.set('/downloads', null);
    const second = await service.generate();
    expect(second.disk).toEqual([
      { path: '/tv', kind: 'rootFolder', freeBytes: 480e9, changeBytes: -20e9 },
      { path: '/downloads', kind: 'download', freeBytes: null, changeBytes: null },
    ]);
    expect(service.list(10).map((s) => s.id)).toEqual([second.id, first.id]);

    setNow(new Date(Date.parse('2026-10-27T08:00:00.000Z') + (SUMMARY_RETENTION_DAYS - 0.5) * DAY).toISOString());
    const third = await service.generate();
    expect(service.list(10).map((s) => s.id)).toEqual([third.id, second.id]);
  });

  it('totals kill-switch lockdowns that overlap the period', async () => {
    const { service, setNow } = await setup('2026-10-25T07:00:00.000Z');
    service.recordLockdown('lockdown', 'VPN down', 2); // starts before the period
    setNow('2026-10-25T09:00:00.000Z');
    service.recordLockdown('unlocked', undefined, 2);
    setNow('2026-10-25T20:00:00.000Z');
    service.recordLockdown('lockdown', 'VPN down', 1);
    setNow('2026-10-25T20:05:00.000Z');
    service.recordLockdown('lockdown', 'again', 1); // same lockdown
    setNow('2026-10-26T07:30:00.000Z'); // still locked at the end
    setNow('2026-10-26T08:00:00.000Z');
    const summary = await service.generate();
    // 08:00-09:00 of the first lockdown, 20:00 until now of the second.
    expect(summary.killSwitch).toEqual({ pauses: 2, totalMs: 1 * 3_600_000 + 12 * 3_600_000 });
  });
});

describe('summaryCron', () => {
  it('turns the configured local time into a daily cron', () => {
    expect(summaryCron({ enabled: true, time: '08:00' })).toBe('0 8 * * *');
    expect(summaryCron({ enabled: true, time: '23:45' })).toBe('45 23 * * *');
    expect(summaryCron({ enabled: false, time: '08:00' })).toBeNull();
  });
});

describe('summary routes', () => {
  async function app() {
    const ctx = await setup();
    const server = Fastify().withTypeProvider<ZodTypeProvider>();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    await server.register(summaryRoutes(ctx.service), { prefix: '/api/v1' });
    return { ...ctx, server };
  }

  it('serves the latest summary, the list and builds one on demand', async () => {
    const { server, sent } = await app();
    expect((await server.inject({ method: 'GET', url: '/api/v1/summary/latest' })).json()).toBeNull();
    const built = await server.inject({ method: 'POST', url: '/api/v1/summary', payload: { notify: true } });
    expect(built.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    const latest = await server.inject({ method: 'GET', url: '/api/v1/summary/latest' });
    expect(latest.json()).toMatchObject({ id: built.json().id, counts: { grabbed: 0 } });
    const list = await server.inject({ method: 'GET', url: '/api/v1/summary?limit=5' });
    expect(list.json()).toHaveLength(1);
    expect((await server.inject({ method: 'GET', url: '/api/v1/summary?limit=0' })).statusCode).toBe(400);
  });

  it('reads and saves the alert settings', async () => {
    const { server, changed } = await app();
    const read = await server.inject({ method: 'GET', url: '/api/v1/settings/alerts' });
    expect(read.json()).toEqual({ ...AlertSettings.parse({}), heldAlerts: 3, quietNow: true });
    expect(read.json()).toMatchObject({ quietHours: { enabled: false, start: '22:00', end: '07:00' }, dailySummary: { enabled: true, time: '08:00' } });

    const body = { quietHours: { enabled: true, start: '23:00', end: '06:30', days: [1, 2, 3, 4, 5] }, dailySummary: { enabled: true, time: '07:15' } };
    const saved = await server.inject({ method: 'PUT', url: '/api/v1/settings/alerts', payload: body });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject(body);
    expect(changed).toEqual([body]);
    expect((await server.inject({ method: 'PUT', url: '/api/v1/settings/alerts', payload: { ...body, dailySummary: { enabled: true, time: '25:00' } } })).statusCode).toBe(400);
  });
});
