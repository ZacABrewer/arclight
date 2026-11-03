/**
 * Time-limited IP bans. A ban lasts `baseMs` (1 h) the first time and doubles on each repeat
 * ban of the same IP up to `maxMs` (24 h): one address is often shared by many people (CGNAT,
 * VPN exits), so a ban must not shut them out for good. An IP's repeat count is forgotten
 * `maxMs` after its last ban ended. The list is bounded; the oldest entries go first.
 */
import { normalizeHost } from './compact.js';

export const BAN_BASE_MS = 60 * 60 * 1000;
export const BAN_MAX_MS = 24 * 60 * 60 * 1000;
export const MAX_BAN_ENTRIES = 10_000;

export interface BanListOptions {
  now: () => number;
  baseMs?: number;
  maxMs?: number;
  maxEntries?: number;
}

interface BanEntry {
  until: number;
  /** Bans so far (1 = first); sets the length of the next one. */
  count: number;
}

export class BanList {
  /** Insertion order = oldest (re)ban first. */
  private readonly entries = new Map<string, BanEntry>();

  constructor(private readonly opts: BanListOptions) {}

  private get baseMs(): number {
    return this.opts.baseMs ?? BAN_BASE_MS;
  }

  private get maxMs(): number {
    return this.opts.maxMs ?? BAN_MAX_MS;
  }

  /** True while `host` is banned. */
  has(host: string): boolean {
    const e = this.entries.get(normalizeHost(host));
    return e !== undefined && e.until > this.opts.now();
  }

  /** Bans `host`; returns the ban length in ms, or 0 when it is banned already. */
  ban(host: string): number {
    const ip = normalizeHost(host);
    const now = this.opts.now();
    const prev = this.entries.get(ip);
    if (prev && prev.until > now) return 0;
    const count = prev && !this.forgotten(prev, now) ? prev.count + 1 : 1;
    const ms = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(count - 1, 30));
    this.entries.delete(ip);
    const max = this.opts.maxEntries ?? MAX_BAN_ENTRIES;
    if (this.entries.size >= max) this.prune(now);
    while (this.entries.size >= max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(ip, { until: now + ms, count });
    return ms;
  }

  /** When the ban on `host` ends (ms epoch), or null when it is not banned. */
  bannedUntil(host: string): number | null {
    const e = this.entries.get(normalizeHost(host));
    return e && e.until > this.opts.now() ? e.until : null;
  }

  /** Entries held (active bans and remembered repeat counts). */
  get size(): number {
    return this.entries.size;
  }

  /** Drops entries whose repeat count is forgotten. */
  prune(now = this.opts.now()): void {
    for (const [ip, e] of this.entries) if (this.forgotten(e, now)) this.entries.delete(ip);
  }

  private forgotten(e: BanEntry, now: number): boolean {
    return now >= e.until + this.maxMs;
  }
}
