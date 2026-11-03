// Failed sign-in limits, shared by every sign-in path (password, media server, 2FA, passkey, app
// sign-in, pair codes, device-code approval, re-authentication, password change).
//
// Three counters, each over a sliding window of `windowMs` since the last failure:
//   - address + account: `maxFailures` wrong guesses, then 429. A success clears only this pair,
//     so signing in to one's own account does not reset the count against someone else's (AUTH-06).
//   - address: `maxFailures × ADDRESS_FACTOR` across all accounts (password spraying), never
//     cleared by a success; it decays with the window.
//   - account, from any address: after `accountMaxFailures`, each further try waits a delay that
//     doubles up to `accountMaxDelayMs`. A backoff, not a lock: someone guessing the owner's
//     password from many addresses cannot keep the owner out for more than that delay, and the
//     counter lives in memory, so a restart clears it.
// Every map is capped (expired entries are pruned first, then the oldest go), so a flood of
// failures from many addresses cannot grow memory without bound (AUTH-07).

export const ADDRESS_FACTOR = 5;
export const MAX_LIMITER_ENTRIES = 10_000;

export interface LoginLimiterOptions {
  /** Failures per address and account (and, × ADDRESS_FACTOR, per address) inside the window. */
  maxFailures?: number;
  windowMs?: number;
  /** Failures per account, from any address, before the backoff starts. */
  accountMaxFailures?: number;
  accountBaseDelayMs?: number;
  accountMaxDelayMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  count: number;
  last: number;
}

export class LoginLimitedError extends Error {
  constructor(
    message: string,
    /** Seconds until the next try is allowed. */
    readonly retryAfter: number,
  ) {
    super(message);
    this.name = 'LoginLimitedError';
  }
}

class Counter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly windowMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string, now: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && now - entry.last > this.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  add(key: string, now: number): Entry {
    const entry = this.get(key, now);
    if (entry) {
      entry.count++;
      entry.last = now;
      // Re-insert so the map stays in last-failure order (the oldest are evicted first).
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry;
    }
    if (this.entries.size >= this.maxEntries) this.prune(now);
    const fresh = { count: 1, last: now };
    this.entries.set(key, fresh);
    return fresh;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.last > this.windowMs) this.entries.delete(key);
    }
    // Still full: drop the oldest tenth (insertion order is last-failure order).
    if (this.entries.size >= this.maxEntries) {
      let drop = Math.max(1, Math.floor(this.maxEntries / 10));
      for (const key of this.entries.keys()) {
        if (drop-- <= 0) break;
        this.entries.delete(key);
      }
    }
  }
}

export class LoginLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly accountMaxFailures: number;
  private readonly accountBaseDelayMs: number;
  private readonly accountMaxDelayMs: number;
  private readonly now: () => number;
  private readonly pairs: Counter;
  private readonly addresses: Counter;
  private readonly accounts: Counter;

  constructor(opts: LoginLimiterOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 10;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.accountMaxFailures = opts.accountMaxFailures ?? 10;
    this.accountBaseDelayMs = opts.accountBaseDelayMs ?? 30_000;
    this.accountMaxDelayMs = opts.accountMaxDelayMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
    const cap = opts.maxEntries ?? MAX_LIMITER_ENTRIES;
    this.pairs = new Counter(this.windowMs, cap);
    this.addresses = new Counter(this.windowMs, cap);
    this.accounts = new Counter(this.windowMs, cap);
  }

  /** Throws LoginLimitedError while `address` (or `account`, from anywhere) must wait. */
  check(address: string, account?: string | null): void {
    const now = this.now();
    const pair = this.pairs.get(pairKey(address, account), now);
    if (pair && pair.count >= this.maxFailures) throw new LoginLimitedError('too many failed sign-ins; try again later', secondsLeft(pair.last + this.windowMs, now));
    const all = this.addresses.get(address, now);
    if (all && all.count >= this.maxFailures * ADDRESS_FACTOR) throw new LoginLimitedError('too many failed sign-ins; try again later', secondsLeft(all.last + this.windowMs, now));
    if (account) {
      const acc = this.accounts.get(accountKey(account), now);
      if (acc && acc.count >= this.accountMaxFailures) {
        const until = acc.last + this.accountDelay(acc.count);
        if (now < until) throw new LoginLimitedError('too many failed sign-ins for this account; try again in a few minutes', secondsLeft(until, now));
      }
    }
  }

  /** Counts one failure for `address` (and `account` when the sign-in named one). */
  fail(address: string, account?: string | null): void {
    const now = this.now();
    this.pairs.add(pairKey(address, account), now);
    this.addresses.add(address, now);
    if (account) this.accounts.add(accountKey(account), now);
  }

  /** A successful sign-in: clears the pair and the account's backoff; the address total decays on its own. */
  succeed(address: string, account?: string | null): void {
    this.pairs.delete(pairKey(address, account));
    if (account) this.accounts.delete(accountKey(account));
  }

  /** Entry counts (tests: the caps hold). */
  sizes(): { pairs: number; addresses: number; accounts: number } {
    return { pairs: this.pairs.size, addresses: this.addresses.size, accounts: this.accounts.size };
  }

  private accountDelay(count: number): number {
    const steps = Math.min(count - this.accountMaxFailures, 20);
    return Math.min(this.accountBaseDelayMs * 2 ** steps, this.accountMaxDelayMs);
  }
}

function accountKey(account: string): string {
  return account.trim().toLowerCase();
}

function pairKey(address: string, account: string | null | undefined): string {
  return account ? `${address}\u0000${accountKey(account)}` : address;
}

function secondsLeft(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 1000));
}
