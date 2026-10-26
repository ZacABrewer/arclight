import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '@media-tron/torrent-engine';
import { torrentEngineCheck } from '../health/checks/torrent.js';
import type { HealthDeps } from '../health/types.js';
import { LOCKDOWN_ADDRESS, TorrentModuleError } from './service.js';
import { harness, randomMagnet, seededTorrent, waitFor, type Harness } from './test-support.js';

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
  });

  it('moves the listener when the port changes and restarts when DHT is toggled', async () => {
    const h = await make({ settings: { enabled: true } });
    await h.service.start();
    const first = running(h);
    const other = h.port + 1 > 65000 ? h.port - 1 : h.port + 1;
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

describe('VPN binding', () => {
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
    const forwarded = h.port + 2 > 65000 ? h.port - 2 : h.port + 2;
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
    const { torrent, infoHash } = await seededTorrent(join(root, 'media-tron'));
    await client.addTorrent({ torrentFile: torrent, title: 'pack', category: 'media-tron' });
    const items = await client.getItems('media-tron');
    expect(items[0]!.id).toBe(infoHash);
    const other = h.port + 3 > 65000 ? h.port - 3 : h.port + 3;
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
