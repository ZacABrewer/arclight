import { lookup as dnsLookup } from 'node:dns/promises';
import { getHeapStatistics, type HeapInfo } from 'node:v8';
import type { DebugEngineSummary, DebugSnapshot, DebugVpnSummary, LogRecord, TorrentSessionStatus, VpnStatus } from '@arclight/shared';
import { arrayBufferCensus, forceGc, type BufferCensus } from './inspector.js';
import { activeHandles, handleCensus, readCgroup, readTextFile, type ActiveHandles, type ReadText } from './probes.js';
import { maskSecrets, redactText } from './redact.js';

/** VPN status plus the two settings that decide the kill switch (never the secrets). */
export interface VpnDetail {
  status: VpnStatus;
  /** Reject grabs while the VPN is down (`vpn.pauseGrabsWhenDown`). */
  pauseGrabsWhenDown: boolean;
  /** WireGuard for Windows: the provider's own kill switch; undefined for other providers. */
  providerKillSwitch?: boolean;
}

export interface DnsAddress {
  address: string;
  family: number;
}

/**
 * Where the debug console reads from. Every source is optional and may throw; production wires
 * them to the per-context services (index.ts), tests pass fakes.
 */
export interface DebugSources {
  version: string;
  isDocker: boolean;
  eventLoopLagP99Ms?: () => number | null;
  torrent?: () => TorrentSessionStatus | null;
  vpn?: () => VpnDetail | null;
  /** Newest first, at most `limit` records matching `match`. */
  logs?: (limit: number, match: (r: LogRecord) => boolean) => LogRecord[];
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<DnsAddress[]>;
  readFile?: ReadText;
  activeHandles?: ActiveHandles;
  memoryUsage?: () => NodeJS.MemoryUsage;
  heapStatistics?: () => HeapInfo;
  census?: () => Promise<BufferCensus>;
  gc?: () => Promise<void>;
  now?: () => number;
}

function attempt<T>(fn: (() => T) | undefined): T | null {
  if (!fn) return null;
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

/** One log record as one redacted line: time LEVEL [component] message {context}. */
export function formatLogLine(r: LogRecord): string {
  const ctx = r.context && Object.keys(r.context).length > 0 ? ` ${JSON.stringify(maskSecrets(r.context))}` : '';
  const comp = r.component ? ` [${r.component}]` : '';
  return redactText(`${r.time} ${r.level.toUpperCase().padEnd(5)}${comp} ${r.message}${ctx}`).replace(/\r?\n/g, '\\n');
}

export class DebugService {
  constructor(private readonly src: DebugSources) {}

  get version(): string {
    return this.src.version;
  }

  get isDocker(): boolean {
    return this.src.isDocker;
  }

  now(): number {
    return (this.src.now ?? Date.now)();
  }

  memoryUsage(): NodeJS.MemoryUsage {
    return (this.src.memoryUsage ?? (() => process.memoryUsage()))();
  }

  heapStatistics(): HeapInfo {
    return (this.src.heapStatistics ?? getHeapStatistics)();
  }

  eventLoopLagP99Ms(): number | null {
    return attempt(this.src.eventLoopLagP99Ms);
  }

  cgroup() {
    return readCgroup(this.src.readFile ?? readTextFile);
  }

  handles() {
    return handleCensus(this.src.activeHandles ?? activeHandles);
  }

  torrent(): TorrentSessionStatus | null {
    return attempt(this.src.torrent);
  }

  vpn(): VpnDetail | null {
    return attempt(this.src.vpn);
  }

  /** Newest `limit` log lines (oldest first, for reading), redacted, filtered on the redacted text. */
  logLines(limit: number, filter?: string): string[] {
    if (!this.src.logs) return [];
    const needle = filter?.trim().toLowerCase() ?? '';
    // Filter on the redacted line so a filter can never probe for a secret's characters.
    const records = this.src.logs(limit, needle ? (r) => formatLogLine(r).toLowerCase().includes(needle) : () => true);
    return records.map(formatLogLine).reverse();
  }

  fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.src.fetch ?? fetch)(url, init);
  }

  lookup(host: string): Promise<DnsAddress[]> {
    return (this.src.lookup ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true })))(host);
  }

  census(): Promise<BufferCensus> {
    return (this.src.census ?? (() => arrayBufferCensus(15)))();
  }

  gc(): Promise<void> {
    return (this.src.gc ?? forceGc)();
  }

  engineSummary(): DebugEngineSummary | null {
    const s = this.torrent();
    if (!s) return null;
    return {
      enabled: s.enabled,
      state: s.state,
      listenPort: s.listenPort,
      boundAddress: s.boundAddress,
      torrents: s.torrents.total,
      downloading: s.torrents.downloading,
      seeding: s.torrents.seeding,
      peers: s.peers,
      downloadRate: s.downloadRate,
      uploadRate: s.uploadRate,
      ...(s.warning ? { warning: redactText(s.warning) } : {}),
      ...(s.error ? { error: redactText(s.error) } : {}),
    };
  }

  vpnSummary(): DebugVpnSummary | null {
    const d = this.vpn();
    if (!d) return null;
    const s = d.status;
    return {
      enabled: s.enabled,
      ...(s.provider ? { provider: s.provider } : {}),
      connected: s.connected,
      ...(s.publicIp ? { publicIp: s.publicIp } : {}),
      ...(s.forwardedPort !== undefined ? { forwardedPort: s.forwardedPort } : {}),
      killSwitchEngaged: s.killSwitchEngaged ?? false,
      lastChecked: s.lastChecked,
      ...(s.error ? { error: redactText(s.error) } : {}),
    };
  }

  snapshot(): DebugSnapshot {
    const m = this.memoryUsage();
    return {
      time: new Date(this.now()).toISOString(),
      version: this.version,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      isDocker: this.isDocker,
      memory: { rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers },
      cgroup: this.cgroup(),
      eventLoopLagP99Ms: this.eventLoopLagP99Ms(),
      handles: this.handles(),
      engine: this.engineSummary(),
      vpn: this.vpnSummary(),
    };
  }
}
