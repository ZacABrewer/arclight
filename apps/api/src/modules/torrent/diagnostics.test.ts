import { afterEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@arclight/shared';
import { killSwitchFlappingCheck, torrentLockdownCheck } from '../health/checks/downloads.js';
import type { HealthDeps } from '../health/types.js';
import { harness, randomMagnet, type Harness } from './test-support.js';

// The kill switch as the queue sees it: lockdown events on the bus, "paused by the VPN kill
// switch" on each download's timeline and state reason, and the lockdown health checks.

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.cleanup();
});

async function make(): Promise<Harness> {
  const h = await harness({ vpn: true, settings: { enabled: true } });
  open.push(h);
  return h;
}

async function setVpn(h: Harness, up: boolean): Promise<void> {
  if (up) h.vpn.connect();
  else h.vpn.drop();
  h.bus.publish({ type: 'vpn', status: h.vpn.status });
  await h.service.applyBinding();
}

const healthDeps = (h: Harness) => ({ torrent: async () => h.service.status() }) as unknown as HealthDeps;

describe('kill switch diagnostics', () => {
  it('publishes lockdown/unlocked with the affected torrents and tracks when and how often', async () => {
    const h = await make();
    // The harness started the engine before any VPN check (lockdown); connect first.
    await setVpn(h, true);
    const events: ServerEvent[] = [];
    h.bus.subscribe((e) => {
      if (e.type === 'torrent') events.push(e);
    });
    const t = await h.service.session!.addTorrent({ magnet: randomMagnet() });

    await setVpn(h, false);
    expect(events).toEqual([expect.objectContaining({ type: 'torrent', action: 'lockdown', infoHashes: [t.infoHashHex] })]);
    const st = h.service.status();
    expect(st.lockdownSince).toBeTruthy();
    expect(st.lockdownsLastHour).toBe(2);
    expect(st.killSwitchPaused).toBe(1);
    expect(h.service.lockdown()).toMatchObject({ reason: expect.stringContaining('kill switch') });

    // Another VPN event while still down is not a new lockdown.
    await setVpn(h, false);
    expect(events).toHaveLength(1);

    await setVpn(h, true);
    expect(events[1]).toMatchObject({ action: 'unlocked', infoHashes: [t.infoHashHex] });
    expect(h.service.status().lockdownSince).toBeUndefined();
    expect(h.service.lockdown()).toBeNull();
  });

  it('writes kill-switch pauses and resumes to the timeline and explains the queue item', async () => {
    const h = await make();
    // The harness started the engine before any VPN check (lockdown); connect first.
    await setVpn(h, true);
    const client = h.downloads.create({ name: 'Built-in', implementation: 'builtin', enable: true, settings: {} });
    const grabbed = await h.downloads.grab(client.id, { title: 'Some.Movie.2024.1080p', magnet: randomMagnet() }, { mediaType: 'movie', movieId: 7 });

    await setVpn(h, false);
    const paused = h.downloads.getQueueItem(grabbed.id);
    expect(paused).toMatchObject({ stateCode: 'killSwitch', stateSeverity: 'error' });
    expect(paused.stateReason).toMatch(/kill switch/i);
    let events = h.downloads.getTimeline(grabbed.id).events;
    expect(events.map((e) => e.type)).toEqual(['grabbed', 'paused']);
    expect(events[1]).toMatchObject({ severity: 'warning', data: { reason: 'killSwitch' } });

    // A queue poll during the lockdown does not record the pause twice.
    await h.downloads.refreshQueue();
    expect(h.downloads.getTimeline(grabbed.id).events.filter((e) => e.type === 'paused')).toHaveLength(1);
    expect(h.downloads.getQueueItem(grabbed.id).statusMessages.flatMap((m) => m.messages).join(' ')).toMatch(/kill switch/i);

    await setVpn(h, true);
    events = h.downloads.getTimeline(grabbed.id).events;
    expect(events.at(-1)).toMatchObject({ type: 'resumed', data: { reason: 'killSwitch' } });
    expect(h.downloads.getQueueItem(grabbed.id).stateCode).not.toBe('killSwitch');
    // Live numbers come straight from the engine.
    expect(h.downloads.getQueueItem(grabbed.id).live).toMatchObject({ downloadRate: expect.any(Number), connectedPeers: 0 });
  });

  it('reports a lockdown and kill-switch flapping as health warnings', async () => {
    const h = await make();
    // The harness started the engine before any VPN check (lockdown); connect first.
    await setVpn(h, true);
    await h.service.session!.addTorrent({ magnet: randomMagnet() });
    expect(await torrentLockdownCheck.run(healthDeps(h))).toEqual([]);

    for (let i = 0; i < 3; i++) {
      await setVpn(h, false);
      if (i < 2) await setVpn(h, true);
    }
    const lockdown = await torrentLockdownCheck.run(healthDeps(h));
    expect(lockdown).toEqual([expect.objectContaining({ source: 'TorrentEngineLockdown', status: 'warning' })]);
    expect(lockdown[0]!.message).toMatch(/1 torrent\(s\) are paused/);
    const flapping = await killSwitchFlappingCheck.run(healthDeps(h));
    expect(flapping).toEqual([expect.objectContaining({ source: 'VpnKillSwitchFlapping', status: 'warning' })]);
    expect(h.service.status().lockdownsLastHour).toBe(4);
    expect(flapping[0]!.message).toContain('4 times');
  });
});
