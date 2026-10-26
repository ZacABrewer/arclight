import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PeerAddress } from '../compact.js';
import { errorMessage } from '../errors.js';
import { HttpTracker, type HttpRequester } from './http-tracker.js';
import type { AnnounceEvent, AnnounceParams, AnnounceResponse, TrackerClient } from './types.js';
import { UdpTracker, type UdpSocketFactory } from './udp-tracker.js';

export type TrackerState = 'notContacted' | 'updating' | 'working' | 'error' | 'disabled';

export interface TrackerStatus {
  url: string;
  tier: number;
  state: TrackerState;
  message?: string;
  peers: number;
  seeds?: number;
  leechers?: number;
  /** Epoch ms of the next scheduled announce for this tracker's tier. */
  nextAnnounceAt?: number;
}

export interface TrackerClientFactoryOptions {
  localAddress?: string;
  userAgent?: string;
  requester?: HttpRequester;
  udpSocketFactory?: UdpSocketFactory;
  timeoutMs?: number;
  udpBaseTimeoutMs?: number;
  udpMaxRetries?: number;
}

/** Default tracker factory: http(s) and udp URLs; anything else is unsupported (null). */
export function createTrackerClient(url: string, opts: TrackerClientFactoryOptions = {}): TrackerClient | null {
  try {
    const proto = new URL(url).protocol;
    if (proto === 'http:' || proto === 'https:') {
      const o: ConstructorParameters<typeof HttpTracker>[1] = {};
      if (opts.localAddress) o.localAddress = opts.localAddress;
      if (opts.userAgent) o.userAgent = opts.userAgent;
      if (opts.requester) o.requester = opts.requester;
      if (opts.timeoutMs) o.timeoutMs = opts.timeoutMs;
      return new HttpTracker(url, o);
    }
    if (proto === 'udp:') {
      const o: ConstructorParameters<typeof UdpTracker>[1] = {};
      if (opts.localAddress) o.localAddress = opts.localAddress;
      if (opts.udpSocketFactory) o.socketFactory = opts.udpSocketFactory;
      if (opts.udpBaseTimeoutMs) o.baseTimeoutMs = opts.udpBaseTimeoutMs;
      if (opts.udpMaxRetries !== undefined) o.maxRetries = opts.udpMaxRetries;
      return new UdpTracker(url, o);
    }
  } catch {
    return null;
  }
  return null;
}

export interface TrackerManagerOptions {
  infoHash: Buffer;
  peerId: Buffer;
  /** BEP 12 tiers. */
  tiers: string[][];
  getPort: () => number;
  getStats: () => { uploaded: number; downloaded: number; left: number };
  numwant?: number;
  /** Announce to every tier in parallel (default true) or stop at the first working tier (strict BEP 12). */
  announceToAllTiers?: boolean;
  clientFactory?: (url: string) => TrackerClient | null;
  /** Lower bound on the re-announce interval in seconds (default 60). */
  minIntervalSec?: number;
  /** First retry delay after a failed announce in seconds; doubles per failure (default 30). */
  retryBaseSec?: number;
  /** Shuffle URLs inside each tier on start, as BEP 12 requires (default true). */
  shuffle?: boolean;
  now?: () => number;
}

interface Entry {
  url: string;
  tier: number;
  client: TrackerClient | null;
  state: TrackerState;
  message?: string;
  peers: number;
  seeds?: number;
  leechers?: number;
  startedSent: boolean;
  completedSent: boolean;
  minIntervalSec: number;
}

/** A unit of scheduling: one tier when announcing to all tiers, otherwise every tier in order. */
interface Group {
  tiers: Entry[][];
  timer: NodeJS.Timeout | undefined;
  nextAt: number | undefined;
  lastAt: number;
  busy: boolean;
  pendingCompleted: boolean;
  failures: number;
}

export interface TrackerManagerEvents {
  peers: [peers: PeerAddress[], url: string];
  announce: [url: string, response: AnnounceResponse];
  error: [url: string, error: Error];
  warning: [url: string, message: string];
}

/** Drives announces for one torrent across its tracker tiers (BEP 12). */
export class TrackerManager extends EventEmitter<TrackerManagerEvents> {
  private readonly groups: Group[] = [];
  private readonly key = randomInt(0, 0xffffffff);
  private running = false;
  private readonly now: () => number;

  constructor(private readonly opts: TrackerManagerOptions) {
    super();
    this.now = opts.now ?? Date.now;
    const factory = opts.clientFactory ?? ((url: string) => createTrackerClient(url));
    const tiers: Entry[][] = opts.tiers.map((urls, tier) => {
      const list = [...new Set(urls)];
      if (opts.shuffle !== false) {
        for (let i = list.length - 1; i > 0; i--) {
          const j = randomInt(0, i + 1);
          [list[i], list[j]] = [list[j] as string, list[i] as string];
        }
      }
      return list.map((url) => {
        const client = factory(url);
        const e: Entry = {
          url,
          tier,
          client,
          state: client ? 'notContacted' : 'disabled',
          peers: 0,
          startedSent: false,
          completedSent: false,
          minIntervalSec: 0,
        };
        if (!client) e.message = 'unsupported tracker protocol';
        return e;
      });
    });
    const mk = (t: Entry[][]): Group => ({ tiers: t, timer: undefined, nextAt: undefined, lastAt: 0, busy: false, pendingCompleted: false, failures: 0 });
    if (opts.announceToAllTiers === false) this.groups.push(mk(tiers));
    else for (const t of tiers) this.groups.push(mk([t]));
  }

  get trackerCount(): number {
    return this.groups.reduce((n, g) => n + g.tiers.reduce((m, t) => m + t.length, 0), 0);
  }

  /** Starts announcing (`started` to each tracker on first contact). */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const g of this.groups) void this.runGroup(g, undefined);
  }

  /** Tells working trackers the download finished. */
  completed(): void {
    if (!this.running) return;
    for (const g of this.groups) void this.runGroup(g, 'completed');
  }

  /** Re-announces now where the tracker's min interval allows (e.g. when short of peers). */
  announceNow(): void {
    if (!this.running) return;
    const now = this.now();
    for (const g of this.groups) {
      const minSec = Math.max(...g.tiers.flat().map((e) => e.minIntervalSec), 0);
      if (now - g.lastAt >= minSec * 1000) void this.runGroup(g, undefined);
    }
  }

  /**
   * Re-announces to every tracker group now, min interval or not (a stalled download asking for
   * fresh peers; callers keep this rare). Returns the number of groups contacted.
   */
  forceAnnounce(): number {
    if (!this.running) return 0;
    let count = 0;
    for (const g of this.groups) {
      if (g.busy) continue;
      void this.runGroup(g, undefined);
      count++;
    }
    return count;
  }

  /** Sends `stopped` to every tracker that saw `started`, bounded by `timeoutMs`. */
  async stop(timeoutMs = 5000): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    for (const g of this.groups) {
      if (g.timer) clearTimeout(g.timer);
      g.timer = undefined;
      g.nextAt = undefined;
    }
    if (!wasRunning) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const entries = this.groups.flatMap((g) => g.tiers.flat()).filter((e) => e.startedSent && e.client);
    await Promise.allSettled(
      entries.map(async (e) => {
        await (e.client as TrackerClient).announce(this.params('stopped'), ac.signal);
        e.startedSent = false;
      }),
    );
    clearTimeout(timer);
  }

  close(): void {
    this.running = false;
    for (const g of this.groups) if (g.timer) clearTimeout(g.timer);
    for (const g of this.groups) for (const e of g.tiers.flat()) e.client?.close();
  }

  getTrackers(): TrackerStatus[] {
    const out: TrackerStatus[] = [];
    for (const g of this.groups) {
      for (const tier of g.tiers) {
        for (const e of tier) {
          const s: TrackerStatus = { url: e.url, tier: e.tier, state: e.state, peers: e.peers };
          if (e.message !== undefined) s.message = e.message;
          if (e.seeds !== undefined) s.seeds = e.seeds;
          if (e.leechers !== undefined) s.leechers = e.leechers;
          if (g.nextAt !== undefined) s.nextAnnounceAt = g.nextAt;
          out.push(s);
        }
      }
    }
    return out.sort((a, b) => a.tier - b.tier);
  }

  private params(event: AnnounceEvent | undefined): AnnounceParams {
    const stats = this.opts.getStats();
    const p: AnnounceParams = {
      infoHash: this.opts.infoHash,
      peerId: this.opts.peerId,
      port: this.opts.getPort(),
      uploaded: stats.uploaded,
      downloaded: stats.downloaded,
      left: stats.left,
      numwant: event === 'stopped' ? 0 : (this.opts.numwant ?? 50),
      key: this.key,
    };
    if (event) p.event = event;
    return p;
  }

  private schedule(g: Group, delayMs: number): void {
    if (!this.running) return;
    if (g.timer) clearTimeout(g.timer);
    g.nextAt = this.now() + delayMs;
    g.timer = setTimeout(() => void this.runGroup(g, undefined), delayMs);
    g.timer.unref();
  }

  private async runGroup(g: Group, event: AnnounceEvent | undefined): Promise<void> {
    if (!this.running) return;
    if (g.busy) {
      if (event === 'completed') g.pendingCompleted = true;
      return;
    }
    g.busy = true;
    g.lastAt = this.now();
    let success = false;
    try {
      outer: for (const tier of g.tiers) {
        for (const e of [...tier]) {
          if (!e.client) continue;
          let ev: AnnounceEvent | undefined = event;
          if (!e.startedSent) ev = 'started';
          else if (event === 'completed' && e.completedSent) ev = undefined;
          e.state = 'updating';
          try {
            const res = await e.client.announce(this.params(ev));
            if (!this.running && ev !== 'started') break outer;
            e.startedSent = true;
            if (ev === 'completed' || (event === 'completed' && ev === 'started')) e.completedSent = true;
            e.state = 'working';
            delete e.message;
            e.peers = res.peers.length;
            if (res.complete !== undefined) e.seeds = res.complete;
            if (res.incomplete !== undefined) e.leechers = res.incomplete;
            e.minIntervalSec = res.minIntervalSec ?? 0;
            if (res.warning) this.emit('warning', e.url, res.warning);
            // BEP 12: a responsive tracker moves to the front of its tier.
            const idx = tier.indexOf(e);
            if (idx > 0) {
              tier.splice(idx, 1);
              tier.unshift(e);
            }
            this.emit('announce', e.url, res);
            if (res.peers.length > 0) this.emit('peers', res.peers, e.url);
            const floor = this.opts.minIntervalSec ?? 60;
            const interval = Math.max(res.intervalSec, res.minIntervalSec ?? 0, floor);
            g.failures = 0;
            success = true;
            this.schedule(g, interval * 1000);
            break outer;
          } catch (err) {
            e.state = 'error';
            e.message = errorMessage(err);
            if (this.listenerCount('error') > 0) this.emit('error', e.url, err instanceof Error ? err : new Error(String(err)));
          }
        }
      }
      if (!success && this.running) {
        g.failures++;
        const base = (this.opts.retryBaseSec ?? 30) * 1000;
        this.schedule(g, Math.min(base * 2 ** (g.failures - 1), 30 * 60 * 1000));
      }
    } finally {
      g.busy = false;
      if (g.pendingCompleted) {
        g.pendingCompleted = false;
        void this.runGroup(g, 'completed');
      }
    }
  }
}
