import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VpnStatus } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import type { Db } from '../../db/index.js';
import { transferDownloadPoints, transferEnginePoints, vpnMetricEvents, vpnMetricPoints } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { DownloadTimelineStore } from '../download-clients/index.js';
import { bucketize } from './aggregate.js';
import { transferMetricsModuleWith } from './index.js';
import { TransferMetricsService, type DownloadSample, type EngineSample } from './service.js';

const T0 = Date.parse('2026-10-26T12:00:00.000Z');
let db: Db;
let nowMs: number;
let downloads: DownloadSample[];
let engine: EngineSample | null;
let vpn: VpnStatus | null;
let bus: EventBus;

const vpnStatus = (over: Partial<VpnStatus> = {}): VpnStatus => ({
  enabled: true,
  connected: true,
  killSwitchEngaged: false,
  lastChecked: null,
  lastChanged: null,
  ...over,
});

function service(): TransferMetricsService {
  return new TransferMetricsService({
    db,
    bus,
    now: () => new Date(nowMs),
    sources: { downloads: () => downloads, engine: () => engine, vpn: () => vpn },
  });
}

beforeEach(async () => {
  db = await createTestDb();
  nowMs = T0;
  bus = new EventBus();
  downloads = [{ id: 7, downloadId: 'abc', progress: 0.1, live: { downloadRate: 1000, uploadRate: 100, connectedPeers: 4, connectedSeeds: 2 } }];
  engine = { downloadRate: 2000, uploadRate: 200, peers: 10, activeTorrents: 3 };
  vpn = vpnStatus({ forwardedPort: 5000 });
});

describe('bucketize', () => {
  it('weights averages by samples, keeps maxima and last values', () => {
    const out = bucketize(
      [
        { time: '2026-10-26T12:00:00.000Z', samples: 1, rate: 10, top: 1, port: 1 as number | null },
        { time: '2026-10-26T12:01:00.000Z', samples: 3, rate: 30, top: 5, port: null },
        { time: '2026-10-26T13:00:00.000Z', samples: 2, rate: 7, top: 2, port: 9 },
      ],
      3_600_000,
      { rate: 'avg', top: 'max', port: 'last' },
    );
    expect(out).toEqual([
      { time: '2026-10-26T12:00:00.000Z', samples: 4, rate: 25, top: 5, port: null },
      { time: '2026-10-26T13:00:00.000Z', samples: 2, rate: 7, top: 2, port: 9 },
    ]);
  });
});

describe('TransferMetricsService', () => {
  it('averages samples per minute and writes the minute when the next one starts', () => {
    const s = service();
    s.sample();
    nowMs += 10_000;
    downloads = [{ id: 7, downloadId: 'abc', progress: 0.2, live: { downloadRate: 3000, uploadRate: 300, connectedPeers: 6, connectedSeeds: 4 } }];
    engine = { downloadRate: 4000, uploadRate: 400, peers: 20, activeTorrents: 3 };
    s.sample();
    expect(db.select().from(transferDownloadPoints).all()).toHaveLength(0);
    nowMs += 60_000;
    s.sample();
    const [row] = db.select().from(transferDownloadPoints).all();
    expect(row).toMatchObject({ trackedDownloadId: 7, infoHash: 'abc', resolution: '1m', time: '2026-10-26T12:00:00.000Z', samples: 2, downloadRate: 2000, uploadRate: 200, peers: 5, seeds: 3, progress: 0.2 });
    expect(db.select().from(transferEnginePoints).get()).toMatchObject({ samples: 2, downloadRate: 3000, peers: 15 });
    expect(db.select().from(vpnMetricPoints).get()).toMatchObject({ samples: 2, connected: 1, killSwitch: 0, forwardedPort: 5000 });
  });

  it('merges a re-flushed minute with the stored one, weighted by samples', () => {
    const s = service();
    s.sample();
    s.flush();
    downloads = [{ id: 7, downloadId: 'abc', progress: 0.05, live: { downloadRate: 4000, uploadRate: 0 } }];
    s.sample();
    s.sample();
    s.flush();
    const rows = db.select().from(transferDownloadPoints).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ samples: 3, downloadRate: 3000, progress: 0.1 });
  });

  it('skips the engine and VPN when they are off, and pending grabs', () => {
    engine = null;
    vpn = vpnStatus({ enabled: false });
    downloads = [{ id: 8, downloadId: 'pending:1', progress: 0 }];
    const s = service();
    s.sample();
    s.flush();
    expect(db.select().from(transferEnginePoints).all()).toHaveLength(0);
    expect(db.select().from(vpnMetricPoints).all()).toHaveLength(0);
    expect(db.select().from(transferDownloadPoints).all()).toHaveLength(0);
  });

  it('serves a download series with the unflushed minute, timeline and VPN annotations', () => {
    const s = service();
    const timeline = new DownloadTimelineStore(db, () => new Date(nowMs));
    timeline.record({ id: 7, downloadId: 'abc', title: 'Show S01E01' }, 'stalled', { time: '2026-10-26T12:01:30.000Z' });
    timeline.record({ id: 7, downloadId: 'abc', title: 'Show S01E01' }, 'paused', { time: '2026-10-26T10:00:00.000Z' });
    s.sample();
    nowMs += 60_000;
    vpn = vpnStatus({ connected: false, killSwitchEngaged: true, error: 'tunnel down' });
    s.sample();
    nowMs += 60_000;
    const m = s.downloadMetrics(7, '1h');
    expect(m.stepMs).toBe(60_000);
    expect(m.points.map((p) => p.time)).toEqual(['2026-10-26T12:00:00.000Z', '2026-10-26T12:01:00.000Z']);
    expect(m.annotations.map((a) => `${a.source}:${a.type}`)).toEqual(['vpn:disconnected', 'vpn:killSwitchEngaged', 'download:stalled']);
    expect(m.annotations[0]).toMatchObject({ severity: 'error', message: 'tunnel down' });
    expect(s.downloadMetrics(7, '6h').annotations.map((a) => a.type)).toContain('paused');
    expect(() => s.downloadMetrics(999, '1h')).toThrow(/not found/);
  });

  it('records VPN transitions from bus events and reports uptime', () => {
    const s = service();
    s.start();
    try {
      s.sample(); // baseline
      bus.publish({ type: 'vpn', status: vpnStatus({ forwardedPort: 6000 }) });
      bus.publish({ type: 'vpn', status: vpnStatus({ forwardedPort: 6000, warning: 'gluetun slow' }) });
      nowMs += 10_000;
      vpn = vpnStatus({ connected: false, forwardedPort: 6000, warning: 'gluetun slow' });
      s.sample();
      const events = db.select().from(vpnMetricEvents).all();
      expect(events.map((e) => e.type)).toEqual(['portChanged', 'warning', 'disconnected']);
      expect(events[0]?.port).toBe(6000);
      const m = s.vpnMetrics('1h');
      expect(m.uptime).toBe(0.5);
      expect(m.points[0]).toMatchObject({ connected: 0.5, warning: 0.5 });
      expect(m.annotations).toHaveLength(3);
    } finally {
      s.stop();
    }
  });

  it('rolls finished hours up once and serves 7 days from hourly plus recent minutes', () => {
    const s = service();
    for (let i = 0; i < 3; i++) {
      s.sample();
      nowMs += 30 * 60_000; // 12:00, 12:30, 13:00
    }
    s.flush();
    // now 13:30: only 12:00-13:00 is finished.
    expect(s.rollup()).toBe(3); // download, engine, vpn
    expect(s.rollup()).toBe(0);
    const hourly = db.select().from(transferEnginePoints).all().filter((r) => r.resolution === '1h');
    expect(hourly).toEqual([expect.objectContaining({ time: '2026-10-26T12:00:00.000Z', samples: 2, downloadRate: 2000 })]);
    const week = s.engineMetrics('7d');
    expect(week.stepMs).toBe(3_600_000);
    expect(week.points.map((p) => [p.time, p.downloadRate])).toEqual([
      ['2026-10-26T12:00:00.000Z', 2000],
      ['2026-10-26T13:00:00.000Z', 2000],
    ]);
  });

  it('prunes minutes after 7 days, hours and VPN events after 90', () => {
    const old = (days: number) => new Date(T0 - days * 86_400_000).toISOString();
    const point = { samples: 1, downloadRate: 1, uploadRate: 1, peers: 1, activeTorrents: 1 };
    db.insert(transferEnginePoints)
      .values([
        { ...point, resolution: '1m', time: old(8) },
        { ...point, resolution: '1m', time: old(6) },
        { ...point, resolution: '1h', time: old(91) },
        { ...point, resolution: '1h', time: old(30) },
      ])
      .run();
    db.insert(vpnMetricEvents).values([{ time: old(91), type: 'connected' }, { time: old(1), type: 'connected' }]).run();
    expect(service().prune()).toEqual({ minutes: 1, hours: 1, events: 1 });
    expect(db.select().from(transferEnginePoints).all()).toHaveLength(2);
  });

  it('serves the routes', async () => {
    const log = pino({ level: 'silent' });
    const ctx: AppContext = { config: {} as AppContext['config'], db, bus, scheduler: new Scheduler(db, bus, log), log, startedAt: new Date() };
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(
      transferMetricsModuleWith({ now: () => new Date(nowMs), sources: { downloads: () => downloads, engine: () => engine, vpn: () => vpn } })(ctx),
      { prefix: '/api/v1' },
    );
    await app.ready();
    try {
      const engineRes = await app.inject({ method: 'GET', url: '/api/v1/metrics/engine?range=24h' });
      expect(engineRes.statusCode).toBe(200);
      expect(engineRes.json()).toMatchObject({ range: '24h', stepMs: 300_000, points: [] });
      expect((await app.inject({ method: 'GET', url: '/api/v1/metrics/vpn' })).json()).toMatchObject({ range: '1h', uptime: null });
      expect((await app.inject({ method: 'GET', url: '/api/v1/metrics/engine?range=2d' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/v1/metrics/downloads/42' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
