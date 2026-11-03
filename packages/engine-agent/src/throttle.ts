/**
 * Per-address back-off after failed authentication. The first `freeFailures` failures cost
 * nothing; each one after that blocks the address for twice as long as the previous block
 * (`baseMs`, 2x, 4x ... up to `maxMs`). A success, or `forgetMs` without a failure once the block
 * is over, clears the address. At most `maxEntries` addresses are tracked (oldest dropped first),
 * so a flood of spoofed or rotating sources cannot grow memory without bound.
 */
export interface AuthThrottleOptions {
  freeFailures?: number;
  baseMs?: number;
  maxMs?: number;
  forgetMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  failures: number;
  blockedUntil: number;
  last: number;
}

/** IPv4-mapped IPv6 (`::ffff:10.0.0.2`) and its IPv4 form count as one address. */
function keyOf(address: string | undefined): string {
  const a = (address ?? '').trim().toLowerCase();
  return a.startsWith('::ffff:') && a.includes('.') ? a.slice(7) : a || 'unknown';
}

export class AuthThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly freeFailures: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly forgetMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: AuthThrottleOptions = {}) {
    this.freeFailures = opts.freeFailures ?? 5;
    this.baseMs = opts.baseMs ?? 1000;
    this.maxMs = opts.maxMs ?? 15 * 60_000;
    this.forgetMs = opts.forgetMs ?? 15 * 60_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /** Milliseconds `address` must still wait; 0 when it may try. */
  retryAfterMs(address: string | undefined): number {
    const key = keyOf(address);
    const e = this.entries.get(key);
    if (!e) return 0;
    const now = this.now();
    if (now >= e.blockedUntil && now - e.last > this.forgetMs) {
      this.entries.delete(key);
      return 0;
    }
    return Math.max(0, e.blockedUntil - now);
  }

  /** Records a failed attempt. */
  fail(address: string | undefined): void {
    const key = keyOf(address);
    const now = this.now();
    const e = this.entries.get(key) ?? { failures: 0, blockedUntil: 0, last: now };
    e.failures += 1;
    e.last = now;
    const over = e.failures - this.freeFailures;
    if (over > 0) e.blockedUntil = now + Math.min(this.maxMs, this.baseMs * 2 ** Math.min(over - 1, 30));
    // Re-insert so the Map's order is least recently failed first.
    this.entries.delete(key);
    this.entries.set(key, e);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** A successful sign-in clears the address. */
  succeed(address: string | undefined): void {
    this.entries.delete(keyOf(address));
  }

  get size(): number {
    return this.entries.size;
  }
}
