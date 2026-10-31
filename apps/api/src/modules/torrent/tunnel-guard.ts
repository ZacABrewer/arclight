import net from 'node:net';

// Tunnel guard: keeps the torrent engine from choking the VPN tunnel. Behind gluetun on a modest
// link, a busy engine filled the tunnel until gluetun's own health check (pings through the
// tunnel) failed and it restarted the VPN, over and over. Bytes are only half the load: a
// userspace WireGuard (gluetun on a NAS kernel without the module) runs out of packets per
// second first, and hundreds of peers keep the tunnel full of small packets at any byte rate.
//
// The guard times a tiny TCP connect through the tunnel every few seconds. The time above the
// lowest recent one is queuing delay in the tunnel. It works like LEDBAT for the whole engine:
// - delay above GUARD_CHOKE_DELAY_MS (or a failed probe): cut the rates to 60% of what flows
//   now, halve the connection cap, and remember the rate the tunnel choked at (the ceiling);
// - delay between target and choke: hold;
// - delay below GUARD_TARGET_DELAY_MS: climb back quickly to the ceiling, then only creep above
//   it while the engine really uses the room, so the tunnel is not driven into the wall again.
// An earlier version let go of its limits once they were well above use; the next burst filled
// the tunnel again, and the VPN struggled in a sawtooth even with three downloads. The ceiling
// is only forgotten after hours without a choke.

/** Floor for guard limits: downloads keep moving even while the tunnel struggles. */
export const GUARD_MIN_DOWN = 256 * 1024;
export const GUARD_MIN_UP = 64 * 1024;
export const GUARD_MIN_CONNECTIONS = 40;
/** While the guard is active: half-open attempts and new attempts per second, at most. */
export const GUARD_HALF_OPEN = 8;
export const GUARD_CONNECTIONS_PER_SECOND = 3;
/**
 * An RTT above this counts as choking whatever the baseline says: the baseline is learned from
 * the probes, so one learned while the tunnel was already saturated (1.5 s in a stress run) hid
 * the problem. A healthy tunnel answers well below this even to a distant exit.
 */
export const GUARD_MAX_RTT_MS = 800;
/** Queuing delay the guard aims to stay under, and the delay that counts as choking. */
export const GUARD_TARGET_DELAY_MS = 150;
export const GUARD_CHOKE_DELAY_MS = 400;
/** Hours without a choke before the guard forgets the ceiling and lets go. */
export const GUARD_FORGET_MS = 6 * 60 * 60 * 1000;
/** Share of the current rate kept after a choke. */
const CUT = 0.6;
/** The ceiling sits this far under the rate the tunnel choked at. */
const CEILING_SHARE = 0.85;
/** Probes the baseline (lowest RTT) is taken over: about 15 minutes at one probe per 3 s. */
const BASELINE_PROBES = 300;
/** Healthy probes between steps above the ceiling (30 s: the tunnel chokes without warning, so creep slowly), and between connection cap steps. */
const CREEP_EVERY = 10;
const CONNECTIONS_EVERY = 3;

export interface GuardLimits {
  /** Bytes/s, null = not limited by the guard. */
  downloadLimit: number | null;
  uploadLimit: number | null;
}

export interface GuardRates {
  down: number;
  up: number;
  /** Open plus half-open peer connections right now. */
  connections: number;
  /** The user's connection cap (what the guard eases back to). */
  maxConnections: number;
  /** Probe time in ms (default: now). */
  at?: number;
}

/** One direction's limit and the rate the tunnel choked at. */
class RateLimit {
  limit: number | null = null;
  ceiling: number | null = null;

  constructor(private readonly min: number) {}

  cut(rate: number): void {
    // A direction that carries next to nothing did not choke the tunnel (upload while nothing
    // seeds); capping it would only strand it at the floor once it is used.
    if (this.limit === null && rate < this.min * 2) return;
    const flowing = Math.max(this.min, this.limit === null ? rate : Math.min(this.limit, Math.max(rate, this.min)));
    this.limit = Math.max(this.min, Math.round(flowing * CUT));
    const choked = Math.max(this.min, Math.round(Math.max(rate, this.limit) * CEILING_SHARE));
    this.ceiling = this.ceiling === null ? choked : Math.min(this.ceiling, choked);
  }

  /** One healthy probe (`healthy` = healthy probes in a row). True when the limit changed. */
  raise(rate: number, healthy: number): boolean {
    const limit = this.limit;
    const ceiling = this.ceiling;
    if (limit === null || ceiling === null) return false;
    if (limit < ceiling) {
      // Back to the ceiling in a few probes.
      this.limit = Math.min(ceiling, limit + Math.max(this.min, Math.round(ceiling * 0.15)));
      return true;
    }
    // At the ceiling: creep up slowly, and only while the room is used (no evidence otherwise).
    if (healthy % CREEP_EVERY !== 0 || rate < limit * 0.8) return false;
    this.ceiling = limit;
    this.limit = Math.round(limit * 1.05);
    return true;
  }

  reset(): void {
    this.limit = null;
    this.ceiling = null;
  }
}

export class TunnelGuard {
  /** Peer connection cap, null = the user's. */
  connectionLimit: number | null = null;
  private readonly down = new RateLimit(GUARD_MIN_DOWN);
  private readonly up = new RateLimit(GUARD_MIN_UP);
  private readonly rtts: number[] = [];
  private healthy = 0;
  /** Probes to skip cutting again after a cut, so the tunnel's queue can drain first. */
  private cooldown = 0;
  private lastChokeAt: number | null = null;

  get downloadLimit(): number | null {
    return this.down.limit;
  }

  get uploadLimit(): number | null {
    return this.up.limit;
  }

  /** The download rate the tunnel last choked at, less a margin; null until it chokes. */
  get downloadCeiling(): number | null {
    return this.down.ceiling;
  }

  get active(): boolean {
    return this.down.limit !== null || this.up.limit !== null || this.connectionLimit !== null;
  }

  /** The probe's RTT in ms (-1 = failed or timed out) and the current engine rates. True when the limits changed. */
  observe(rttMs: number, rates: GuardRates): boolean {
    const at = rates.at ?? Date.now();
    if (rttMs >= 0) {
      this.rtts.push(rttMs);
      if (this.rtts.length > BASELINE_PROBES) this.rtts.shift();
    }
    const delay = rttMs < 0 ? Infinity : rttMs - Math.min(...this.rtts);
    if (rttMs < 0 || rttMs > GUARD_MAX_RTT_MS || delay > GUARD_CHOKE_DELAY_MS) {
      this.healthy = 0;
      this.lastChokeAt = at;
      if (this.cooldown > 0) {
        this.cooldown--;
        return false;
      }
      this.cooldown = 1;
      this.down.cut(rates.down);
      this.up.cut(rates.up);
      const from = this.connectionLimit ?? Math.min(rates.maxConnections, Math.max(rates.connections, GUARD_MIN_CONNECTIONS * 2));
      // Never above the user's cap: a cap already below the floor stays as the user set it.
      this.connectionLimit = Math.min(rates.maxConnections, Math.max(GUARD_MIN_CONNECTIONS, Math.round(from / 2)));
      if (this.connectionLimit >= rates.maxConnections) this.connectionLimit = null;
      return true;
    }
    this.cooldown = 0;
    if (delay > GUARD_TARGET_DELAY_MS) {
      this.healthy = 0;
      return false;
    }
    if (!this.active) return false;
    if (this.lastChokeAt !== null && at - this.lastChokeAt >= GUARD_FORGET_MS) {
      this.reset();
      return true;
    }
    this.healthy++;
    let changed = this.down.raise(rates.down, this.healthy);
    changed = this.up.raise(rates.up, this.healthy) || changed;
    if (this.connectionLimit !== null && this.healthy % CONNECTIONS_EVERY === 0) {
      const next = Math.round(this.connectionLimit * 1.5);
      this.connectionLimit = next >= rates.maxConnections ? null : next;
      changed = true;
    }
    return changed;
  }

  reset(): void {
    this.down.reset();
    this.up.reset();
    this.connectionLimit = null;
    this.healthy = 0;
    this.cooldown = 0;
    this.lastChokeAt = null;
  }
}

/** The tighter of the user's limit (0 = unlimited) and the guard's (null = none). */
export function combineLimit(user: number, guard: number | null): number {
  if (guard === null) return user;
  return user === 0 ? guard : Math.min(user, guard);
}

/** Times a TCP connect to 1.1.1.1:443 (through the tunnel when Arclight runs in gluetun's namespace). */
export function tcpConnectProbe(host = '1.1.1.1', port = 443, timeoutMs = 4000): Promise<number> {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    const done = (ms: number): void => {
      clearTimeout(timer);
      sock.destroy();
      resolve(ms);
    };
    const timer = setTimeout(() => done(-1), timeoutMs);
    sock.once('connect', () => done(Date.now() - started));
    sock.once('error', () => done(-1));
  });
}
