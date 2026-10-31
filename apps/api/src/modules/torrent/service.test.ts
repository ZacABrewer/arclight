import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '@arclight/torrent-engine';
import { torrentEngineCheck } from '../health/checks/torrent.js';
import type { HealthDeps } from '../health/types.js';
import { LOCKDOWN_ADDRESS, TorrentModuleError } from './service.js';
import { freePort, harness, randomMagnet, seededTorrent, waitFor, type Harness } from './test-support.js';
import { GUARD_CONNECTIONS_PER_SECOND, GUARD_HALF_OPEN } from './tunnel-guard.js';

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.cleanup();
});

async function make(...args: Parameters<typeof harness>): Promise<Harness> {
  const h = await harness(...args);
  open.push(h);
  return h;
}

function running(h: Harness): Session {
  const s = h.service.session;
  if (!s) throw new Error('engine not running');
  return s;
}

/** A second free port (not h.port + n: a neighbouring port may be bound by a parallel test). */
async function otherPort(h: Harness): Promise<number> {
  for (;;) {
    const port = await freePort();
    if (port !== h.port) return port;
  }
}

const healthDeps = (h: Harness) => ({ torrent: async () => h.service.status() }) as unknown as HealthDeps;

describe('torrent settings', () => {
  it('serves defaults with the derived downloads root and resume dir', async () => {
    const h = await make();
    const res = h.service.settingsResponse();
    expect(res).toMatchObject({ bindToVpn: true, maxActiveDownloads: 3, downloadsRoot: '', defaultSeedRatio: null });
    expect(res.effectiveDownloadsRoot).toBe(resolve(h.configDir, '..', 'downloads'));
    expect(res.resumeDir).toBe(join(h.configDir, 'torrents'));
  });

  it('uses /downloads in Docker and an explicit root when set', async () => {
    const h = await make({ service: { isDocker: true } });
    expect(h.service.effectiveDownloadsRoot()).toBe('/downloads');
    const res = await h.service.updateSettings({ downloadsRoot: '/data/dl' });
    expect(res.effectiveDownloadsRoot).toBe('/data/dl');
  });

  it('rejects invalid values without saving them', async () => {
    const h = await make();
    await expect(h.service.updateSettings({ listenPort: 0 })).rejects.toBeInstanceOf(TorrentModuleError);
    expect(h.service.settings().listenPort).toBe(h.port);
  });
});

describe('engine lifecycle', () => {
  it('starts when enabled and stops when disabled', async () => {
    const h = await make();
    expect(h.service.status().state).toBe('disabled');
    await h.service.updateSettings({ enabled: true });
    expect(running(h).listenPort).toBe(h.port);
    expect(h.service.status()).toMatchObject({ state: 'running', listenPort: h.port, boundAddress: '127.0.0.1', enabled: true });
    expect(existsSync(join(h.configDir, 'torrents'))).toBe(true);
    await h.service.updateSettings({ enabled: false });
    expect(h.service.session).toBeNull();
    expect(h.service.status()).toMatchObject({ state: 'disabled', listenPort: null });
  });

  it('applies limits and queue settings live, without a restart', async () => {
    const h = await make({ settings: { enabled: true } });
    await h.service.start();
    const before = running(h);
    await h.service.updateSettings({ downloadLimitKbps: 100, uploadLimitKbps: 50, maxActiveDownloads: 1, defaultSeedRatio: 2, defaultSeedTimeMinutes: 10 });
    expect(h.service.session).toBe(before);
    expect(before.settings).toMatchObject({ downloadLimit: 102_400, uploadLimit: 51_200, maxActiveDownloads: 1, seedRatioLimit: 2, seedTimeLimitMs: 600_000 });
    // Disk-bound defaults: two checks at once, magnets fail after an hour without metadata.
    expect(before.settings).toMatchObject({ maxActiveChecks: 2, metadataTimeoutMs: 3_600_000 });
    await h.service.updateSettings({ maxActiveChecks: 1, metadataTimeoutMinutes: 0 });
    expect(before.settings).toMatchObject({ maxActiveChecks: 1, metadataTimeoutMs: 0 });
  });

  it('moves the listener when the port changes and restarts when DHT is toggled', async () => {
    const h = await make({ settings: { enabled: true } });
    await h.service.start();
    const first = running(h);
    const other = await otherPort(h);
    await h.service.updateSettings({ listenPort: other });
    expect(first.listenPort).toBe(other);
    await h.service.updateSettings({ dht: true });
    expect(h.service.session).not.toBe(first);
    expect(running(h).settings.dht).toBe(true);
  });

  it('reports a start failure (port in use) as an error state and health error', async () => {
    const h = await make();
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(h.port, '127.0.0.1', () => r()));
    try {
      await h.service.updateSettings({ enabled: true });
      expect(h.service.session).toBeNull();
      const st = h.service.status();
      expect(st.state).toBe('error');
      expect(st.error).toBeTruthy();
      const findings = await torrentEngineCheck.run(healthDeps(h));
      expect(findings[0]).toMatchObject({ source: 'TorrentEngine', status: 'error' });
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('restores torrents from resume data on restart', async () => {
    const h = await make({ settings: { enabled: true } });
    await h.service.start();
    const t = await running(h).addTorrent({ magnet: randomMagnet(), category: 'tv' });
    await h.service.stop();
    await h.service.start();
    expect(running(h).getTorrent(t.infoHashHex)?.category).toBe('tv');
  });
});

describe('disk guard', () => {
  const MiB = 1024 * 1024;

  it('limits downloads to what the disk writes while it falls behind, shows it, and lets go when it keeps up', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const h = await make({ settings: { enabled: true }, service: { now: () => new Date(clock) } });
    await h.service.start();
    const session = running(h);
    let disk = { writtenBytes: 0, writeLatencyMs: 5, queuedWrites: 0, backlogBytes: 0, backlogLimitBytes: 64 * MiB, backpressured: 0, checksActive: 0, checksQueued: 0 };
    session.getDiskStats = () => disk;
    const step = (writeRate: number, patch: Partial<typeof disk> = {}): void => {
      clock += 5000;
      disk = { ...disk, ...patch, writtenBytes: disk.writtenBytes + writeRate * 5 };
      h.service.diskGuardTick();
    };
    h.service.diskGuardTick();
    step(15 * MiB, { backlogBytes: 2 * MiB });
    expect(session.settings.downloadLimit).toBe(0);
    expect(h.service.status().diskGuard).toMatchObject({ downloadLimit: null, writeRate: 15 * MiB, backlogBytes: 2 * MiB });
    // The backlog fills: the limit drops to a little under the measured write rate.
    step(15 * MiB, { backlogBytes: 48 * MiB, backpressured: 1 });
    const limit = Math.round(15 * MiB * 0.9);
    expect(session.settings.downloadLimit).toBe(limit);
    expect(h.service.status().diskGuard).toMatchObject({ downloadLimit: limit, backlogBytes: 48 * MiB });
    // A tighter user limit wins.
    await h.service.updateSettings({ downloadLimitKbps: 4096 });
    expect(session.settings.downloadLimit).toBe(4 * MiB);
    await h.service.updateSettings({ downloadLimitKbps: 0 });
    expect(session.settings.downloadLimit).toBe(limit);
    // Healthy and downloads are slow now: released.
    for (let i = 0; i < 60 && h.service.status().diskGuard?.downloadLimit !== null; i++) step(MiB, { backlogBytes: 0, backpressured: 0 });
    expect(h.service.status().diskGuard?.downloadLimit).toBeNull();
    expect(session.settings.downloadLimit).toBe(0);
  });

  it('switched off: no limit and nothing in the status', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const h = await make({ settings: { enabled: true }, service: { now: () => new Date(clock) } });
    await h.service.start();
    const session = running(h);
    let written = 0;
    session.getDiskStats = () => ({ writtenBytes: (written += 50 * MiB), writeLatencyMs: 5, queuedWrites: 0, backlogBytes: 60 * MiB, backlogLimitBytes: 64 * MiB, backpressured: 2, checksActive: 0, checksQueued: 0 });
    h.service.diskGuardTick();
    clock += 5000;
    h.service.diskGuardTick();
    expect(session.settings.downloadLimit).toBeGreaterThan(0);
    await h.service.updateSettings({ diskGuard: false });
    h.service.diskGuardTick();
    expect(session.settings.downloadLimit).toBe(0);
    expect(h.service.status().diskGuard).toBeUndefined();
  });
});

describe('VPN binding', () => {
  it('tunnel guard: slows the engine when the tunnel chokes, keeps a safe limit, and forgets it after hours', async () => {
    const MiB = 1024 * 1024;
    let rtt = 100;
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const h = await make({ vpn: true, settings: { enabled: true }, service: { tunnelProbe: async () => rtt, now: () => new Date(clock) } });
    h.vpn.connect();
    await h.service.start();
    await h.service.applyBinding();
    const s = running(h);
    const stats = s.getSessionStats.bind(s);
    let rate = 20 * MiB;
    s.getSessionStats = () => ({ ...stats(), downloadRate: rate });
    for (let i = 0; i < 3; i++) await h.service.guardTick();
    expect(s.settings.downloadLimit).toBe(0);
    rtt = -1;
    await h.service.guardTick();
    expect(s.settings.downloadLimit).toBe(12 * MiB);
    expect(h.service.status().tunnelGuard?.downloadLimit).toBe(s.settings.downloadLimit);
    // healthy again: back up to just under the rate it choked at (85%), not unlimited
    rtt = 100;
    rate = 10 * MiB;
    for (let i = 0; i < 20; i++) {
      clock += 3000;
      await h.service.guardTick();
    }
    expect(s.settings.downloadLimit).toBe(17 * MiB);
    clock += 6 * 60 * 60 * 1000;
    await h.service.guardTick();
    expect(h.service.status().tunnelGuard).toBeUndefined();
    expect(s.settings.downloadLimit).toBe(0);
  });

  it('tunnel guard: cuts the connection cap and dialing while active, and restores the user values', async () => {
    let rtt = 100;
    const h = await make({ vpn: true, settings: { enabled: true, maxConnections: 300 }, service: { tunnelProbe: async () => rtt } });
    h.vpn.connect();
    await h.service.start();
    await h.service.applyBinding();
    const s = running(h);
    const before = { maxConnections: s.settings.maxConnections, half: s.settings.maxHalfOpenConnections, perSecond: s.settings.connectionsPerSecond };
    expect(before.maxConnections).toBe(300);
    rtt = -1;
    await h.service.guardTick();
    expect(s.settings.maxConnections).toBeLessThan(300);
    expect(s.settings.maxHalfOpenConnections).toBe(GUARD_HALF_OPEN);
    expect(s.settings.connectionsPerSecond).toBe(GUARD_CONNECTIONS_PER_SECOND);
    expect(h.service.status().tunnelGuard?.connectionLimit).toBe(s.settings.maxConnections);
    rtt = 100;
    for (let i = 0; i < 60 && h.service.status().tunnelGuard; i++) await h.service.guardTick();
    expect(s.settings).toMatchObject({ maxConnections: 300, maxHalfOpenConnections: before.half, connectionsPerSecond: before.perSecond });
    expect(h.service.status().limits).toMatchObject({ maxConnections: 300 });
  });

  it('self-heals: unlocks a lockdown whose VPN event was missed, and starts an engine that failed at boot', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const h = await make({ vpn: true, settings: { enabled: true }, service: { now: () => new Date(clock) } });
    await h.service.stop(); // the harness may already have started it
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(h.port, '127.0.0.1', () => r()));
    await h.service.boot();
    expect(h.service.status().state).toBe('error');
    await new Promise<void>((r) => blocker.close(() => r()));
    await h.service.reconcile(); // too soon after the failed attempt
    expect(h.service.session).toBeNull();
    clock += 61_000;
    await h.service.reconcile();
    expect(h.service.status().state).toBe('lockdown');
    // the VPN comes up but its event never reaches the engine
    h.vpn.connect();
    await h.service.reconcile();
    expect(h.service.status()).toMatchObject({ state: 'running', boundAddress: '127.0.0.2' });
  });

  it('locks down when the VPN is enabled but not checked yet, then binds to the tunnel on connect', async () => {
    const h = await make({ vpn: true, settings: { enabled: true } });
    await h.service.start();
    const s = running(h);
    expect(h.service.status()).toMatchObject({ state: 'lockdown', boundAddress: LOCKDOWN_ADDRESS });
    expect(h.service.status().lockdownReason).toContain('first VPN check');
    h.vpn.connect();
    h.bus.publish({ type: 'vpn', status: h.vpn.status });
    await h.service.applyBinding();
    expect(s.settings.listenAddress).toBe('127.0.0.2');
    expect(h.service.status()).toMatchObject({ state: 'running', boundAddress: '127.0.0.2' });
  });

  it('pauses everything on the kill switch and resumes only those torrents on reconnect', async () => {
    const h = await make({ vpn: true, settings: { enabled: true } });
    h.vpn.connect();
    await h.service.start();
    const s = running(h);
    const a = await s.addTorrent({ magnet: randomMagnet() });
    const b = await s.addTorrent({ magnet: randomMagnet() });
    await h.service.pause(b.infoHashHex); // user-paused: must stay paused
    h.vpn.drop();
    h.bus.publish({ type: 'vpn', status: h.vpn.status });
    await h.service.applyBinding();
    expect(a.isPaused).toBe(true);
    expect(h.service.status()).toMatchObject({ state: 'lockdown', boundAddress: LOCKDOWN_ADDRESS });
    expect(h.service.killSwitchPausedIds()).toEqual([a.infoHashHex]);
    expect(existsSync(join(h.configDir, 'torrents', 'killswitch-paused.json'))).toBe(true);
    await expect(h.service.resume(a.infoHashHex)).rejects.toMatchObject({ code: 'CONFLICT' });

    h.vpn.connect();
    h.bus.publish({ type: 'vpn', status: h.vpn.status });
    await h.service.applyBinding();
    expect(a.isPaused).toBe(false);
    expect(b.isPaused).toBe(true);
    expect(h.service.killSwitchPausedIds()).toEqual([]);
    expect(existsSync(join(h.configDir, 'torrents', 'killswitch-paused.json'))).toBe(false);
  });

  it('resumes kill-switch-paused torrents after a restart once the VPN is up', async () => {
    const h = await make({ vpn: true, settings: { enabled: true } });
    h.vpn.connect();
    await h.service.start();
    const t = await running(h).addTorrent({ magnet: randomMagnet() });
    h.vpn.drop();
    await h.service.applyBinding();
    await h.service.stop();
    h.vpn.connect();
    await h.service.start();
    await waitFor(() => running(h).getTorrent(t.infoHashHex));
    expect(running(h).getTorrent(t.infoHashHex)!.isPaused).toBe(false);
  });

  it('follows the port forwarded by the VPN', async () => {
    const h = await make({ vpn: true, settings: { enabled: true } });
    h.vpn.connect();
    await h.service.start();
    const forwarded = await otherPort(h);
    h.vpn.connect({ forwardedPort: forwarded });
    h.bus.publish({ type: 'vpn', status: h.vpn.status });
    await h.service.applyBinding();
    expect(running(h).listenPort).toBe(forwarded);
    expect(h.service.status()).toMatchObject({ listenPort: forwarded, configuredListenPort: h.port, vpn: { forwardedPort: forwarded } });
  });

  it('ignores the VPN when bindToVpn is off, and health warns about the non-VPN address', async () => {
    const h = await make({ vpn: true, settings: { enabled: true, bindToVpn: false } });
    h.vpn.connect();
    await h.service.start();
    expect(h.service.status()).toMatchObject({ state: 'running', boundAddress: '127.0.0.1' });
    const findings = await torrentEngineCheck.run(healthDeps(h));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('not the VPN tunnel address 127.0.0.2');
  });

  it('listens on the forwarded port even when bindToVpn is off', async () => {
    const h = await make({ vpn: true, settings: { enabled: true, bindToVpn: false } });
    h.vpn.connect();
    await h.service.start();
    const forwarded = await otherPort(h);
    h.vpn.connect({ forwardedPort: forwarded });
    await h.service.applyBinding();
    expect(running(h).listenPort).toBe(forwarded);
    expect(h.service.status()).toMatchObject({ state: 'running', boundAddress: '127.0.0.1', listenPort: forwarded });
  });

  it('falls back to the configured port when another program holds the forwarded port', async () => {
    const h = await make({ vpn: true, settings: { enabled: true, bindToVpn: false } });
    const forwarded = await otherPort(h);
    const squatter = await holdPort(forwarded);
    try {
      h.vpn.connect({ forwardedPort: forwarded });
      await h.service.stop();
      await h.service.start();
      expect(h.service.status()).toMatchObject({ state: 'running', listenPort: h.port });
      expect(h.service.status().warning).toContain(`Port ${forwarded} is already in use`);
      // Further VPN checks with the same forwarded port leave the engine where it is.
      await h.service.applyBinding();
      expect(running(h).listenPort).toBe(h.port);
    } finally {
      await new Promise<void>((done) => squatter.close(() => done()));
    }
  });

  it('moves off a newly forwarded port that is taken, and clears the warning on the next one', async () => {
    const h = await make({ vpn: true, settings: { enabled: true, bindToVpn: false } });
    h.vpn.connect();
    await h.service.start();
    const taken = await otherPort(h);
    const squatter = await holdPort(taken);
    try {
      h.vpn.connect({ forwardedPort: taken });
      await h.service.applyBinding();
      expect(h.service.status()).toMatchObject({ state: 'running', listenPort: h.port });
      expect(h.service.status().warning).toBeDefined();
    } finally {
      await new Promise<void>((done) => squatter.close(() => done()));
    }
    const fresh = await otherPort(h);
    h.vpn.connect({ forwardedPort: fresh });
    await h.service.applyBinding();
    expect(running(h).listenPort).toBe(fresh);
    expect(h.service.status().warning).toBeUndefined();
  });

  it('health is clean when bound to the tunnel', async () => {
    const h = await make({ vpn: true, settings: { enabled: true } });
    h.vpn.connect();
    await h.service.start();
    expect(await torrentEngineCheck.run(healthDeps(h))).toEqual([]);
  });
});

describe('download client integration', () => {
  it('auto-registers a Built-in client once when none exists', async () => {
    const h = await make();
    const created = h.service.autoRegisterClient();
    expect(created).toMatchObject({ name: 'Built-in', implementation: 'builtin', protocol: 'torrent' });
    expect(h.service.settings().autoRegisterClient).toBe(false);
    h.downloads.delete(created!.id);
    expect(h.service.autoRegisterClient()).toBeNull();
    expect(h.downloads.list()).toHaveLength(0);
  });

  it('does not register when a client already exists', async () => {
    const h = await make();
    h.downloads.create({ name: 'qB', implementation: 'qbittorrent', settings: { host: 'nas' } });
    expect(h.service.autoRegisterClient()).toBeNull();
    expect(h.downloads.list().map((c) => c.name)).toEqual(['qB']);
  });

  it('builtin clients drive the running Session, and setListenPortOnAll reaches them', async () => {
    const h = await make({ settings: { enabled: true } });
    await h.service.start();
    const c = h.service.autoRegisterClient()!;
    const client = h.downloads.clientById(c.id);
    expect((await client.test()).version).toContain('0.1.0');
    const root = h.service.effectiveDownloadsRoot();
    await mkdir(root, { recursive: true });
    const { torrent, infoHash } = await seededTorrent(join(root, 'arclight'));
    await client.addTorrent({ torrentFile: torrent, title: 'pack', category: 'arclight' });
    const items = await client.getItems('arclight');
    expect(items[0]!.id).toBe(infoHash);
    const other = await otherPort(h);
    const results = await h.downloads.setListenPortOnAll(other);
    expect(results).toEqual([{ id: c.id, name: 'Built-in', ok: true }]);
    expect(running(h).listenPort).toBe(other);
    await h.service.stop();
    await expect(client.test()).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('torrent actions', () => {
  it('lists details and applies pause, resume, priority, sequential and move', async () => {
    const h = await make({ settings: { enabled: true } });
    await h.service.start();
    const root = h.service.effectiveDownloadsRoot();
    await mkdir(root, { recursive: true });
    const { torrent, infoHash } = await seededTorrent(root);
    const s = running(h);
    const t = await s.addTorrent({ torrent, category: 'tv' });
    await waitFor(() => t.state === 'seeding');
    const [detail] = h.service.listTorrents({ id: infoHash.toUpperCase() });
    expect(detail).toMatchObject({ id: infoHash, name: 'pack', state: 'seeding', category: 'tv', private: false, progress: 1 });
    expect(detail!.files.map((f) => f.path)).toEqual(['pack/a.bin', 'pack/b.bin']);
    expect(h.service.listTorrents({ category: 'movies' })).toEqual([]);

    await h.service.pause(infoHash);
    expect(t.isPaused).toBe(true);
    await h.service.resume(infoHash);
    expect(t.isPaused).toBe(false);
    await h.service.recheck(infoHash);
    await waitFor(() => t.state === 'seeding');
    await h.service.setPriority(infoHash, { files: [{ index: 1, priority: 0 }], sequential: true });
    expect(t.getFiles().map((f) => f.priority)).toEqual([1, 0]);
    expect(t.sequential).toBe(true);
    await expect(h.service.setPriority(infoHash, { files: [{ index: 9, priority: 1 }] })).rejects.toMatchObject({ code: 'VALIDATION' });

    const target = join(h.dir, 'moved');
    await mkdir(target, { recursive: true });
    await h.service.move(infoHash, target);
    expect(t.savePath).toBe(target);
    expect(existsSync(join(target, 'pack', 'a.bin'))).toBe(true);
  });

  it('reports not found and not running', async () => {
    const h = await make();
    await expect(h.service.pause('a'.repeat(40))).rejects.toMatchObject({ code: 'NOT_RUNNING' });
    await h.service.updateSettings({ enabled: true });
    await expect(h.service.pause('a'.repeat(40))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/** Listens on 127.0.0.1:port the way another torrent client in the same namespace would. */
function holdPort(port: number): Promise<Server> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => done(server));
  });
}
