import { ProviderError, type ProviderErrorCode, type ProviderKind, type ThrottleRule } from './types.js';

// Per-provider throttle state (spec section 13 / providers 1.7). Pure and serialisable so
// the api module can persist it.

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Default throttle per error class. `null` means "never throttle". */
export const DEFAULT_THROTTLE: Readonly<Record<ProviderErrorCode | 'unknown', ThrottleRule | null>> = {
  'rate-limited': { kind: 'duration', ms: HOUR },
  'daily-limit': { kind: 'until-utc', hour: 0, minute: 0 },
  unreachable: { kind: 'duration', ms: 20 * MIN },
  'api-throttled': { kind: 'duration', ms: 10 * MIN },
  'bad-response': { kind: 'duration', ms: 6 * HOUR },
  config: { kind: 'duration', ms: 12 * HOUR },
  auth: { kind: 'duration', ms: 12 * HOUR },
  captcha: { kind: 'duration', ms: 12 * HOUR },
  'not-found': null,
  unsupported: null,
  'must-blacklist': null,
  unknown: { kind: 'duration', ms: 10 * MIN },
};

/** Classes that count strikes before throttling (R13.4). */
export const COUNTED_CODES: ReadonlySet<ProviderErrorCode> = new Set(['rate-limited', 'unreachable', 'api-throttled']);
/** Classes whose duration doubles on consecutive throttles. */
const ESCALATING: ReadonlySet<string> = new Set(['rate-limited', 'unreachable', 'api-throttled', 'bad-response', 'unknown']);
export const MAX_BACKOFF_MS = 24 * HOUR;

export interface ThrottleEntry {
  provider: ProviderKind;
  code: ProviderErrorCode | 'unknown';
  description: string;
  /** ISO timestamp the provider may be used again. */
  until: string;
}

export interface ThrottleOptions {
  now?: (() => number) | undefined;
  strikes?: number | undefined;
  strikeWindowMs?: number | undefined;
  overrides?: Partial<Record<ProviderKind, Partial<Record<ProviderErrorCode, ThrottleRule>>>> | undefined;
  initial?: readonly ThrottleEntry[] | undefined;
}

export type ErrorOutcome =
  | { action: 'throttled'; entry: ThrottleEntry }
  | { action: 'strike'; strikes: number }
  | { action: 'ignored' };

/** Next occurrence of hour:minute UTC strictly after `now`. */
export function nextUtcTime(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0);
  return t > now ? t : t + 24 * HOUR;
}

export class ThrottleTracker {
  private readonly entries = new Map<ProviderKind, ThrottleEntry>();
  private readonly strikes = new Map<ProviderKind, number[]>();
  /** Consecutive throttles without a success in between (exponential backoff). */
  private readonly consecutive = new Map<ProviderKind, number>();
  private readonly now: () => number;
  private readonly maxStrikes: number;
  private readonly window: number;
  private readonly overrides: NonNullable<ThrottleOptions['overrides']>;

  constructor(opts: ThrottleOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxStrikes = opts.strikes ?? 5;
    this.window = opts.strikeWindowMs ?? 120_000;
    this.overrides = opts.overrides ?? {};
    for (const e of opts.initial ?? []) this.entries.set(e.provider, e);
  }

  setOverrides(provider: ProviderKind, rules: Partial<Record<ProviderErrorCode, ThrottleRule>> | undefined): void {
    if (rules) this.overrides[provider] = { ...rules, ...this.overrides[provider] };
  }

  /** Active throttle for a provider, lifting it if expired. */
  get(provider: ProviderKind): ThrottleEntry | undefined {
    const e = this.entries.get(provider);
    if (!e) return undefined;
    if (Date.parse(e.until) <= this.now()) {
      this.entries.delete(provider);
      return undefined;
    }
    return e;
  }

  isThrottled(provider: ProviderKind): boolean {
    return this.get(provider) !== undefined;
  }

  list(): ThrottleEntry[] {
    for (const p of [...this.entries.keys()]) this.get(p);
    return [...this.entries.values()];
  }

  /** Clear all, or only auth/config/captcha entries (R13.8). */
  reset(onlyAuthOrConfig = false): void {
    for (const [p, e] of [...this.entries]) {
      if (!onlyAuthOrConfig || e.code === 'auth' || e.code === 'config' || e.code === 'captcha') this.entries.delete(p);
    }
  }

  recordSuccess(provider: ProviderKind): void {
    this.consecutive.delete(provider);
    this.strikes.delete(provider);
  }

  /** Throttle duration in ms for an error, before escalation. */
  private untilFor(provider: ProviderKind, code: ProviderErrorCode | 'unknown', err: unknown): number | undefined {
    const now = this.now();
    if (err instanceof ProviderError && err.resetAt !== undefined && err.resetAt > now) return err.resetAt;
    const rule = (code !== 'unknown' ? this.overrides[provider]?.[code] : undefined) ?? DEFAULT_THROTTLE[code];
    if (!rule) return undefined;
    if (rule.kind === 'until-utc') return nextUtcTime(now, rule.hour, rule.minute);
    let ms = rule.ms;
    if (ESCALATING.has(code)) {
      const n = this.consecutive.get(provider) ?? 0;
      ms = Math.min(ms * 2 ** n, MAX_BACKOFF_MS);
    }
    if (err instanceof ProviderError && err.retryAfterMs !== undefined) ms = Math.max(ms, err.retryAfterMs);
    return now + ms;
  }

  /**
   * Record a failure. Counted classes only throttle on the Nth strike inside the window;
   * earlier strikes return 'strike' so the caller can sleep and retry.
   */
  recordError(provider: ProviderKind, err: unknown): ErrorOutcome {
    const code: ProviderErrorCode | 'unknown' = err instanceof ProviderError ? err.code : 'unknown';
    if (code !== 'unknown' && DEFAULT_THROTTLE[code] === null && !this.overrides[provider]?.[code]) return { action: 'ignored' };
    const now = this.now();
    if (code !== 'unknown' && COUNTED_CODES.has(code)) {
      const recent = (this.strikes.get(provider) ?? []).filter((t) => now - t < this.window);
      recent.push(now);
      if (recent.length < this.maxStrikes) {
        this.strikes.set(provider, recent);
        return { action: 'strike', strikes: recent.length };
      }
      this.strikes.delete(provider);
    }
    const until = this.untilFor(provider, code, err);
    if (until === undefined) return { action: 'ignored' };
    const entry: ThrottleEntry = {
      provider,
      code,
      description: err instanceof Error ? err.message : String(err),
      until: new Date(until).toISOString(),
    };
    this.entries.set(provider, entry);
    if (ESCALATING.has(code)) this.consecutive.set(provider, (this.consecutive.get(provider) ?? 0) + 1);
    return { action: 'throttled', entry };
  }

  /** Throttle immediately regardless of strikes (e.g. after exhausting retries). */
  forceThrottle(provider: ProviderKind, err: unknown): ThrottleEntry | undefined {
    this.strikes.set(provider, Array.from({ length: this.maxStrikes }, () => this.now()));
    const r = this.recordError(provider, err);
    return r.action === 'throttled' ? r.entry : undefined;
  }
}
