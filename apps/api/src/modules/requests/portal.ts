import type { PublicPortal } from '@arclight/shared';
import type { RequestsService } from './service.js';

// Public request portal: the portal descriptor for the login page and a per-IP token bucket
// that limits anonymous discover browsing.

export interface RateLimitOptions {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export const DEFAULT_PORTAL_RATE_LIMIT: RateLimitOptions = { capacity: 30, refillPerSecond: 0.5 };
const MAX_BUCKETS = 10_000;

/** A token bucket per key (client IP). */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly opts: RateLimitOptions = DEFAULT_PORTAL_RATE_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token; false when the bucket is empty. */
  take(key: string): boolean {
    const now = this.now();
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.opts.capacity, b.tokens + ((now - b.at) / 1000) * this.opts.refillPerSecond);
      b.at = now;
    } else {
      if (this.buckets.size >= MAX_BUCKETS) this.prune(now);
      b = { tokens: this.opts.capacity, at: now };
      this.buckets.set(key, b);
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Seconds until the next token for `key`. */
  retryAfter(key: string): number {
    const b = this.buckets.get(key);
    if (!b || b.tokens >= 1) return 0;
    return Math.ceil((1 - b.tokens) / this.opts.refillPerSecond);
  }

  private prune(now: number): void {
    // Full buckets carry no state worth keeping.
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((now - b.at) / 1000) * this.opts.refillPerSecond >= this.opts.capacity) this.buckets.delete(key);
    }
    if (this.buckets.size >= MAX_BUCKETS) this.buckets.clear();
  }
}

export type MediaServerLoginOption = PublicPortal['loginMethods']['mediaServer'];

/** GET /public/portal. */
export function publicPortal(requests: RequestsService, mediaServerLogin: () => MediaServerLoginOption): PublicPortal {
  const s = requests.settings();
  const server = mediaServerLogin();
  return {
    enabled: s.publicPortal.enabled,
    title: 'Arclight',
    applicationUrl: s.applicationUrl,
    message: s.publicPortal.message,
    allowAnonymousDiscover: s.publicPortal.enabled && s.publicPortal.allowAnonymousDiscover,
    loginMethods: { local: true, mediaServer: server, plex: server?.kind === 'plex' },
  };
}
