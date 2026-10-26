import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createAgent, type NotificationAgentKind, type NotificationEvent } from '@arclight/notifications';
import type { DownloadEvent, HealthCheck, NotificationInputRaw, QuietHoursSettings, ServerEvent } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { downloadClients, trackedDownloads } from '../../db/schema.js';
import { DownloadAlerts, KILL_SWITCH_URGENT_MS } from './download-alerts.js';
import { isQuietAt } from './quiet-hours.js';
import * as tables from './schema.js';
import { NotificationsService } from './service.js';

const log = pino({ level: 'silent' });

// 2026-10-26 is a Monday. Dates are built in local time, as quiet hours are.
const local = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);

const QUIET: QuietHoursSettings = { enabled: true, start: '22:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] };

describe('isQuietAt', () => {
  it('handles a window that runs past midnight', () => {
    expect(isQuietAt(QUIET, local(26, 21, 59))).toBe(false);
    expect(isQuietAt(QUIET, local(26, 22, 0))).toBe(true);
    expect(isQuietAt(QUIET, local(27, 3, 0))).toBe(true);
    expect(isQuietAt(QUIET, local(27, 7, 0))).toBe(false);
  });

  it('counts the early hours to the day the window started on', () => {
    const mondayOnly = { ...QUIET, days: [1] };
    expect(isQuietAt(mondayOnly, local(26, 23, 0))).toBe(true); // Monday night
    expect(isQuietAt(mondayOnly, local(27, 6, 0))).toBe(true); // Tuesday morning, Monday's window
    expect(isQuietAt(mondayOnly, local(27, 23, 0))).toBe(false); // Tuesday night
    expect(isQuietAt(mondayOnly, local(26, 6, 0))).toBe(false); // Monday morning is Sunday's window
  });

  it('handles a same-day window and the off switches', () => {
    const lunch = { ...QUIET, start: '12:00', end: '13:30' };
    expect(isQuietAt(lunch, local(26, 12, 45))).toBe(true);
    expect(isQuietAt(lunch, local(26, 13, 30))).toBe(false);
    expect(isQuietAt({ ...QUIET, enabled: false }, local(26, 23))).toBe(false);
    expect(isQuietAt({ ...QUIET, days: [] }, local(26, 23))).toBe(false);
    expect(isQuietAt({ ...QUIET, end: '22:00' }, local(26, 23))).toBe(false);
  });
});

// ---- download alerts -----------------------------------------------------------------------

function entry(type: string, extra: Partial<DownloadEvent> = {}): ServerEvent {
  return {
    type: 'download',
    action: 'event',
    event: {
      id: 1,
      trackedDownloadId: 7,
      downloadId: 'abc',
      title: 'Show.S01E01.1080p',
      type: type as DownloadEvent['type'],
      severity: 'warning',
      time: '2026-10-26T10:00:00.000Z',
      ...extra,
    },
  };
}

const health = (checks: HealthCheck[]): ServerEvent => ({
  type: 'health',
  health: { status: checks.some((c) => c.status === 'error') ? 'error' : checks.length ? 'warning' : 'ok', checks },
});

async function alertsSetup() {
  const db = await createTestDb({ downloadClients, trackedDownloads });
  let now = new Date('2026-10-26T10:00:00.000Z');
  const alerts = new DownloadAlerts({ db, log, now: () => now });
  return { db, alerts, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('DownloadAlerts', () => {
  it('maps timeline entries to stalled, import and generic alerts', async () => {
    const { alerts } = await alertsSetup();
    const [stalled] = alerts.translate(entry('stalled', { message: 'No new data for 30 minutes' }));
    expect(stalled).toMatchObject({ type: 'downloadStalled', download: { trackedDownloadId: 7, title: 'Show.S01E01.1080p' }, message: 'No new data for 30 minutes' });
    expect(alerts.translate(entry('importFailed', { message: 'Disk error' }))[0]).toMatchObject({ type: 'importProblem', problem: 'failed', message: 'Disk error' });
    expect(alerts.translate(entry('importBlocked', { message: 'Unknown series' }))[0]).toMatchObject({ type: 'importProblem', problem: 'blocked' });
    expect(alerts.translate(entry('recovered', { severity: 'ok', message: 'Data again' }))[0]).toMatchObject({
      type: 'downloadUpdate',
      timelineType: 'recovered',
      severity: 'ok',
      message: 'Data again',
    });
    for (const routine of ['grabbed', 'started', 'paused', 'resumed', 'completed', 'imported', 'removed']) {
      expect(alerts.translate(entry(routine))).toEqual([]);
    }
  });

  it('delivers timeline types it does not know with their own message', async () => {
    const { alerts } = await alertsSetup();
    const [event] = alerts.translate(entry('releaseReplaced', { severity: 'info', message: 'Swapped for Show.S01E01.720p' }));
    expect(event).toMatchObject({ type: 'downloadUpdate', timelineType: 'releaseReplaced', message: 'Swapped for Show.S01E01.720p' });
  });

  it('sends one kill-switch alert per lockdown, a resume follow-up and one urgent reminder', async () => {
    const { db, alerts, advance } = await alertsSetup();
    for (const [hash, title] of [['h1', 'One'], ['h2', 'Two']]) {
      db.insert(trackedDownloads)
        .values({ downloadId: hash!, title: title!, state: 'downloading', statusMessages: [], protocol: 'torrent', addedAt: '2026-10-26T09:00:00Z', updatedAt: '2026-10-26T09:00:00Z' } as typeof trackedDownloads.$inferInsert)
        .run();
    }
    const [paused] = alerts.translate({ type: 'torrent', action: 'lockdown', reason: 'VPN down.', infoHashes: ['h1', 'h2'] });
    expect(paused).toMatchObject({ type: 'killSwitch', reason: 'VPN down.', pausedCount: 2, titles: ['One', 'Two'] });
    expect(paused?.urgent).toBeUndefined();
    // More torrents paused within the same lockdown: no second alert.
    expect(alerts.translate({ type: 'torrent', action: 'lockdown', infoHashes: ['h3'] })).toEqual([]);

    expect(alerts.tick()).toEqual([]);
    advance(KILL_SWITCH_URGENT_MS);
    const [reminder] = alerts.tick();
    expect(reminder).toMatchObject({ type: 'killSwitch', pausedMinutes: 30, urgent: true });
    expect(alerts.tick()).toEqual([]);

    advance(5 * 60_000);
    const [resumed] = alerts.translate({ type: 'torrent', action: 'unlocked', infoHashes: ['h1', 'h2'] });
    expect(resumed).toMatchObject({ type: 'killSwitchResumed', resumedCount: 2, durationMs: 35 * 60_000, reason: 'VPN down.' });
    expect(alerts.translate({ type: 'torrent', action: 'unlocked', infoHashes: [] })).toEqual([]);
  });

  it('stays quiet about a lockdown that paused nothing', async () => {
    const { alerts, advance } = await alertsSetup();
    expect(alerts.translate({ type: 'torrent', action: 'lockdown', infoHashes: [] })).toEqual([]);
    advance(KILL_SWITCH_URGENT_MS * 2);
    expect(alerts.tick()).toEqual([]);
    expect(alerts.translate({ type: 'torrent', action: 'unlocked', infoHashes: [] })).toEqual([]);
  });

  it('raises disk space once per transition into warning or error', async () => {
    const { alerts } = await alertsSetup();
    const warn: HealthCheck = { source: 'RootFolderFreeSpace', status: 'warning', message: 'Less than 1 GiB free on /tv' };
    const full: HealthCheck = { source: 'DownloadDiskSpace', status: 'error', message: '2 download(s) cannot finish' };
    const other: HealthCheck = { source: 'IndexerStatus', status: 'error', message: 'indexer down' };

    expect(alerts.translate(health([warn, other]))).toMatchObject([{ type: 'diskSpaceLow', health: warn }]);
    expect(alerts.translate(health([warn, other]))).toEqual([]);
    const [urgent] = alerts.translate(health([warn, full]));
    expect(urgent).toMatchObject({ type: 'diskSpaceLow', health: full, urgent: true });
    // Escalation of an existing source counts, recovery resets it.
    expect(alerts.translate(health([{ ...warn, status: 'error' }, full]))).toHaveLength(1);
    expect(alerts.translate(health([]))).toEqual([]);
    expect(alerts.translate(health([warn]))).toHaveLength(1);
  });
});

// ---- quiet hours in dispatch ---------------------------------------------------------------

interface Sent {
  name: string;
  event: NotificationEvent;
}

async function dispatchSetup(start: Date) {
  const db = await createTestDb({ ...tables });
  const sent: Sent[] = [];
  let now = start;
  const failing = new Set<string>();
  const service = new NotificationsService({
    db,
    log,
    now: () => now,
    quietHours: () => QUIET,
    agentFactory: (kind: NotificationAgentKind, settings) => {
      const real = createAgent(kind, settings);
      const url = String((settings as Record<string, unknown>)['url']);
      return {
        kind,
        supportedEvents: real.supportedEvents,
        async send(event) {
          if (failing.has(url)) throw new Error('refused');
          sent.push({ name: url.split('/').pop() ?? '', event });
        },
        async test() {},
      };
    },
  });
  const create = (name: string, extra: Partial<NotificationInputRaw> = {}) =>
    service.create({ name, implementation: 'webhook', settings: { url: `https://hooks.example/${name}` }, onDownloadStalled: true, onKillSwitch: true, onDiskSpaceLow: true, ...extra });
  return { db, service, sent, failing, create, setNow: (d: Date) => (now = d) };
}

const base = { instanceName: 'Arclight', timestamp: '2026-10-26T22:30:00Z' };
const download = { trackedDownloadId: 1, downloadId: 'abc', title: 'Show.S01E01' };

describe('quiet hours', () => {
  it('holds non-urgent alerts for connections that respect quiet hours and sends them as one batch later', async () => {
    const { db, service, sent, create, setNow } = await dispatchSetup(local(26, 23));
    create('quiet');
    create('loud', { respectQuietHours: false });

    const outcomes = await service.dispatch({ ...base, type: 'downloadStalled', download, message: 'No data' });
    expect(outcomes.find((o) => o.name === 'quiet')).toMatchObject({ ok: true, held: true });
    expect(sent.map((s) => s.name)).toEqual(['loud']);
    await service.dispatch({ ...base, type: 'downloadStalled', download: { ...download, title: 'Other' } });
    // Persisted, so a restart keeps them.
    expect(db.select().from(tables.notificationHeld).all()).toHaveLength(2);
    expect(service.heldCount()).toBe(2);

    // Still quiet: nothing flushed.
    expect(await service.flushHeld()).toBe(0);

    setNow(local(27, 7, 1));
    sent.length = 0;
    expect(await service.flushHeld()).toBe(2);
    expect(sent).toHaveLength(1);
    const batch = sent[0]!.event;
    expect(batch.type).toBe('heldAlerts');
    if (batch.type === 'heldAlerts') expect(batch.events.map((e) => e.type)).toEqual(['downloadStalled', 'downloadStalled']);
    expect(service.heldCount()).toBe(0);
  });

  it('sends a single held alert as itself and keeps alerts whose delivery failed', async () => {
    const { service, sent, failing, create, setNow } = await dispatchSetup(local(26, 23));
    create('quiet');
    await service.dispatch({ ...base, type: 'downloadStalled', download });
    setNow(local(27, 8));
    failing.add('https://hooks.example/quiet');
    expect(await service.flushHeld()).toBe(0);
    expect(service.heldCount()).toBe(1);
    failing.clear();
    expect(await service.flushHeld()).toBe(1);
    expect(sent.map((s) => s.event.type)).toEqual(['downloadStalled']);
  });

  it('lets urgent alerts through and reminds only connections that held the original', async () => {
    const { service, sent, create } = await dispatchSetup(local(26, 23));
    create('quiet');
    create('loud', { respectQuietHours: false });
    await service.dispatch({ ...base, type: 'diskSpaceLow', urgent: true, health: { source: 'DownloadDiskSpace', status: 'error', message: 'full' } });
    expect(sent.map((s) => s.name).sort()).toEqual(['loud', 'quiet']);

    sent.length = 0;
    await service.dispatch({ ...base, type: 'killSwitch', since: base.timestamp, pausedCount: 1, titles: ['x'], pausedMinutes: 30, urgent: true });
    expect(sent.map((s) => s.name)).toEqual(['quiet']);
  });

  it('sends everything at once outside quiet hours and drops reminders there', async () => {
    const { service, sent, create } = await dispatchSetup(local(26, 15));
    create('quiet');
    await service.dispatch({ ...base, type: 'downloadStalled', download });
    await service.dispatch({ ...base, type: 'killSwitch', since: base.timestamp, pausedCount: 1, titles: [], pausedMinutes: 30, urgent: true });
    expect(sent.map((s) => s.event.type)).toEqual(['downloadStalled']);
    expect(service.heldCount()).toBe(0);
  });

  it('stores respectQuietHours and the new triggers on connections', async () => {
    const { service, create } = await dispatchSetup(local(26, 15));
    const created = create('quiet', { onDailySummary: true });
    expect(created).toMatchObject({ respectQuietHours: true, onDailySummary: true, onDownloadStalled: true, supportsOnDailySummary: true, supportsOnKillSwitch: true });
    const updated = service.update(created.id, { name: 'quiet', implementation: 'webhook', settings: { url: 'https://hooks.example/quiet' }, respectQuietHours: false });
    expect(updated.respectQuietHours).toBe(false);
    expect(updated.onDailySummary).toBe(false);
    const template = service.schemas().find((s) => s.implementation === 'discord')!.template;
    expect(template).toMatchObject({ respectQuietHours: true, onDownloadStalled: true, onKillSwitch: true, onDailySummary: true });
    const plex = service.schemas().find((s) => s.implementation === 'plex')!;
    expect(plex.supportsOnDownloadStalled).toBe(false);
  });
});
