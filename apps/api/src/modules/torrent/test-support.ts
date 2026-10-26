import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { createTorrent, type SessionSettings } from '@arclight/torrent-engine';
import type { VpnStatus } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import type { Db } from '../../db/index.js';
import { EventBus } from '../../events.js';
import * as dcTables from '../download-clients/schema.js';
import { DownloadClientsService } from '../download-clients/service.js';
import { TorrentService, type TorrentServiceOptions, type TorrentVpnPort } from './service.js';

// Test-only helpers: a controllable VPN port, temp dirs, free ports and a service wired to a
// real Session on loopback. Not used by production code.

/** Fast, offline session timers (no DHT bootstrap nodes). */
export const FAST: Partial<SessionSettings> = {
  dhtBootstrapNodes: [],
  tickIntervalMs: 50,
  chokeIntervalMs: 300,
  trackerMinIntervalSec: 0,
  trackerRetrySec: 0.2,
  peerRetryMs: 200,
  connectTimeoutMs: 2000,
};

export class FakeVpn implements TorrentVpnPort {
  settingsEnabled = true;
  status: VpnStatus = { enabled: false, connected: false, lastChecked: null, lastChanged: null };

  enabled(): boolean {
    return this.settingsEnabled;
  }
  getStatus(): VpnStatus {
    return this.status;
  }
  getTunnelAddress(): string | null {
    const st = this.status;
    if (!st.enabled || !st.connected || st.leak || st.killSwitchEngaged) return null;
    return st.tunnelAddress ?? null;
  }
  connect(extra: Partial<VpnStatus> = {}): void {
    this.status = { enabled: true, connected: true, tunnelAddress: '127.0.0.2', lastChecked: new Date().toISOString(), lastChanged: null, ...extra };
  }
  drop(): void {
    this.status = { enabled: true, connected: false, killSwitchEngaged: true, lastChecked: new Date().toISOString(), lastChanged: null };
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface Harness {
  db: Db;
  dir: string;
  configDir: string;
  bus: EventBus;
  vpn: FakeVpn;
  downloads: DownloadClientsService;
  service: TorrentService;
  port: number;
  cleanup: () => Promise<void>;
}

export async function harness(
  opts: { vpn?: boolean; settings?: Record<string, unknown>; service?: Partial<TorrentServiceOptions> } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-torrent-'));
  const configDir = join(dir, 'config');
  await mkdir(configDir, { recursive: true });
  const db = await createTestDb({ ...dcTables });
  const bus = new EventBus();
  const vpn = new FakeVpn();
  vpn.settingsEnabled = opts.vpn ?? false;
  const downloads = new DownloadClientsService({ db, platform: process.platform === 'win32' ? 'win32' : 'posix', directoryExists: async () => true });
  const port = await freePort();
  const service = new TorrentService({
    db,
    configDir,
    isDocker: false,
    bus,
    log: pino({ level: 'silent' }),
    vpn,
    downloadClients: downloads,
    sessionOverrides: FAST,
    defaultAddress: '127.0.0.1',
    ...opts.service,
  });
  downloads.setTorrentSession(() => service.session);
  // Seed the section directly so the first start already uses the free port and no DHT.
  await service.updateSettings({ enabled: false, listenPort: port, dht: false, ...opts.settings });
  const cleanup = async () => {
    await service.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  return { db, dir, configDir, bus, vpn, downloads, service, port, cleanup };
}

export function randomMagnet(): string {
  return `magnet:?xt=urn:btih:${randomBytes(20).toString('hex')}&dn=test`;
}

/** Writes a small payload under `dir` and returns a matching .torrent (so the torrent seeds). */
export async function seededTorrent(dir: string, name = 'pack'): Promise<{ torrent: Buffer; infoHash: string }> {
  const files = [
    { path: ['a.bin'], data: randomBytes(70_000) },
    { path: ['b.bin'], data: randomBytes(1_000) },
  ];
  for (const f of files) {
    const full = join(dir, name, ...f.path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, f.data);
  }
  const created = createTorrent({ name, files, pieceLength: 16 * 1024 });
  return { torrent: created.torrent, infoHash: created.metainfo.infoHash.toString('hex') };
}

export function waitFor<T>(cond: () => T | undefined | false | null, ms = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const v = cond();
      if (v) {
        clearInterval(iv);
        resolve(v);
      } else if (Date.now() - start > ms) {
        clearInterval(iv);
        reject(new Error('timed out waiting for condition'));
      }
    }, 20);
  });
}
