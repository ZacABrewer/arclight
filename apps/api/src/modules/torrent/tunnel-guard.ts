import net from 'node:net';

// Tunnel guard: keeps the torrent engine from choking the VPN tunnel. Behind gluetun on a modest
// link, a busy engine filled the tunnel until gluetun's own health check (pings through the
// tunnel) failed and it restarted the VPN, over and over. The guard times a tiny TCP connect
// through the tunnel; when that latency balloons or the connect fails, it halves the engine's
// rates at once, then eases them back up after the tunnel has stayed healthy for a while.

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
/** Healthy probes in a row before the limits are raised one step. */
const HEALTHY_STEPS = 3;
const RAISE = 1.5;

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
}

export class TunnelGuard {
  downloadLimit: number | null = null;
  uploadLimit: number | null = null;
  /** Peer connection cap, null = the user's. */
  connectionLimit: number | null = null;
  private baseline: number | null = null;
  private healthy = 0;

  get active(): boolean {
    return this.downloadLimit !== null || this.uploadLimit !== null || this.connectionLimit !== null;
  }

  /** The probe's RTT in ms (-1 = failed or timed out) and the current engine rates. True when the limits changed. */
  observe(rttMs: number, rates: GuardRates): boolean {
    const base = this.baseline;
    const bad = rttMs < 0 || rttMs > GUARD_MAX_RTT_MS || (base !== null && rttMs > Math.max(base * 4, base + 400));
    if (!bad) {
      // Lowest RTT seen, drifting up slowly so a route change does not leave it too low forever.
      this.baseline = base === null || rttMs < base ? rttMs : base + (rttMs - base) * 0.02;
    }
    if (bad) {
      this.healthy = 0;
      this.downloadLimit = Math.max(GUARD_MIN_DOWN, Math.round((this.downloadLimit ?? Math.max(rates.down, GUARD_MIN_DOWN * 2)) / 2));
      this.uploadLimit = Math.max(GUARD_MIN_UP, Math.round((this.uploadLimit ?? Math.max(rates.up, GUARD_MIN_UP * 2)) / 2));
      const from = this.connectionLimit ?? Math.min(rates.maxConnections, Math.max(rates.connections, GUARD_MIN_CONNECTIONS * 2));
      // Never above the user's cap: a cap already below the floor stays as the user set it.
      this.connectionLimit = Math.min(rates.maxConnections, Math.max(GUARD_MIN_CONNECTIONS, Math.round(from / 2)));
      if (this.connectionLimit >= rates.maxConnections) this.connectionLimit = null;
      return true;
    }
    if (!this.active) return false;
    if (++this.healthy < HEALTHY_STEPS) return false;
    this.healthy = 0;
    this.downloadLimit = raise(this.downloadLimit, rates.down);
    this.uploadLimit = raise(this.uploadLimit, rates.up);
    this.connectionLimit = raiseConnections(this.connectionLimit, rates.maxConnections);
    return true;
  }

  reset(): void {
    this.downloadLimit = null;
    this.uploadLimit = null;
    this.connectionLimit = null;
    this.healthy = 0;
  }
}

/** One step up; released (null) once it reaches the user's cap. */
function raiseConnections(limit: number | null, max: number): number | null {
  if (limit === null) return null;
  const next = Math.round(limit * RAISE);
  return next >= max ? null : next;
}

/** One step up; released (null) once the limit is well above what the engine actually uses. */
function raise(limit: number | null, rate: number): number | null {
  if (limit === null) return null;
  const next = Math.round(limit * RAISE);
  return next > Math.max(rate * 2, 1024 * 1024) ? null : next;
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
