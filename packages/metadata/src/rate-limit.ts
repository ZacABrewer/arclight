// Process-wide token-bucket rate limiter keyed by provider name.
//
// Each provider has a bucket (requests per second + burst) and two FIFO queues: interactive
// requests (a user waiting on a lookup) are always served before background ones (refresh
// jobs). A 429/503 pauses the whole provider for the backoff delay, so every queued request
// waits instead of hammering a service that already said "slow down". The clock is
// injectable so tests run on virtual time.

import { parseRetryAfter } from './tmdb/client.js';

export type RequestPriority = 'interactive' | 'background';

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ProviderLimit {
  /** Sustained rate. */
  requestsPerSecond: number;
  /** Bucket size (requests that may go out back to back). Defaults to 1. */
  burst?: number;
}

export interface AcquireOptions {
  priority?: RequestPriority;
  signal?: AbortSignal;
}

export interface ScheduleOptions extends AcquireOptions {
  /** Retries after a 429/503 response. Defaults to 3. */
  maxRetries?: number;
}

export interface RateLimiterOptions {
  clock?: Clock;
  /** Jitter source in [0, 1). Injectable for deterministic tests. */
  random?: () => number;
  /** Base of the exponential backoff when the server sends no Retry-After. */
  backoffBaseMs?: number;
  /** Upper bound of any single backoff, Retry-After included. */
  maxBackoffMs?: number;
  /** Limit used for providers nobody configured. Defaults to 1 req/s. */
  defaultLimit?: ProviderLimit;
}

const DEFAULT_LIMIT: ProviderLimit = { requestsPerSecond: 1, burst: 1 };
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;
/** Absorbs floating point drift when refilling tokens. */
const EPSILON = 1e-9;

interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
}

interface ProviderState {
  /** Tokens per millisecond. */
  rate: number;
  capacity: number;
  tokens: number;
  updatedAt: number;
  pausedUntil: number;
  interactive: Waiter[];
  background: Waiter[];
  armed: boolean;
}

/** Statuses that mean "too many requests, try later". MusicBrainz uses 503 for this. */
export function isThrottleStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/**
 * Delay before retry `attempt` (0-based). A server-sent Retry-After wins (plus up to half a
 * base unit of jitter so a crowd of clients does not return in lockstep); otherwise
 * exponential backoff with "equal jitter" (half fixed, half random).
 */
export function computeBackoffMs(
  attempt: number,
  retryAfterMs: number | undefined,
  options: { random?: () => number; baseMs?: number; maxMs?: number } = {},
): number {
  const random = options.random ?? Math.random;
  const base = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const max = options.maxMs ?? DEFAULT_MAX_BACKOFF_MS;
  if (retryAfterMs !== undefined) {
    return Math.min(max, Math.max(0, retryAfterMs) + Math.floor(random() * (base / 2)));
  }
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.floor(exp / 2 + random() * (exp / 2));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

export class RateLimiter {
  readonly clock: Clock;
  private readonly random: () => number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly defaultLimit: ProviderLimit;
  private readonly providers = new Map<string, ProviderState>();

  constructor(options: RateLimiterOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
  }

  /** Sets (or changes) a provider's limit. Queued requests keep their place. */
  configure(provider: string, limit: ProviderLimit): void {
    if (!(limit.requestsPerSecond > 0)) {
      throw new RangeError(`requestsPerSecond for ${provider} must be positive`);
    }
    const capacity = Math.max(1, limit.burst ?? 1);
    const state = this.providers.get(provider);
    if (state) {
      this.refill(state);
      state.rate = limit.requestsPerSecond / 1000;
      state.capacity = capacity;
      state.tokens = Math.min(state.tokens, capacity);
      this.drain(state);
      return;
    }
    this.providers.set(provider, this.newState(limit));
  }

  /** The limit currently applied to `provider`. */
  limitOf(provider: string): Required<ProviderLimit> {
    const state = this.state(provider);
    return { requestsPerSecond: state.rate * 1000, burst: state.capacity };
  }

  /** Number of requests waiting for a token. */
  pending(provider: string): number {
    const state = this.providers.get(provider);
    return state ? state.interactive.length + state.background.length : 0;
  }

  /** Resolves when a request to `provider` may go out. Rejects when `signal` aborts first. */
  acquire(provider: string, options: AcquireOptions = {}): Promise<void> {
    const { priority = 'background', signal } = options;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const state = this.state(provider);
    return new Promise<void>((resolve, reject) => {
      const queue = priority === 'interactive' ? state.interactive : state.background;
      const waiter: Waiter = { resolve, reject, cleanup: () => {} };
      if (signal) {
        const onAbort = (): void => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      queue.push(waiter);
      this.drain(state);
    });
  }

  /** Holds every request to `provider` back for at least `delayMs`. */
  pause(provider: string, delayMs: number): void {
    const state = this.state(provider);
    state.pausedUntil = Math.max(state.pausedUntil, this.clock.now() + Math.max(0, delayMs));
    this.drain(state);
  }

  backoffDelay(attempt: number, retryAfterMs: number | undefined): number {
    return computeBackoffMs(attempt, retryAfterMs, {
      random: this.random,
      baseMs: this.backoffBaseMs,
      maxMs: this.maxBackoffMs,
    });
  }

  /**
   * Runs `send` under the provider's limit. A 429/503 response pauses the provider (Retry-After
   * honoured) and the request is retried up to `maxRetries` times; the last response is
   * returned as-is so the caller maps it to an error.
   */
  async schedule(
    provider: string,
    send: () => Promise<Response>,
    options: ScheduleOptions = {},
  ): Promise<Response> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    for (let attempt = 0; ; attempt += 1) {
      await this.acquire(provider, options);
      const response = await send();
      if (!isThrottleStatus(response.status) || attempt >= maxRetries) return response;
      const retryAfter = parseRetryAfter(
        response.headers.get('retry-after'),
        new Date(this.clock.now()),
      );
      this.pause(provider, this.backoffDelay(attempt, retryAfter));
      await response.body?.cancel().catch(() => {});
    }
  }

  private newState(limit: ProviderLimit): ProviderState {
    const capacity = Math.max(1, limit.burst ?? 1);
    return {
      rate: limit.requestsPerSecond / 1000,
      capacity,
      tokens: capacity,
      updatedAt: this.clock.now(),
      pausedUntil: 0,
      interactive: [],
      background: [],
      armed: false,
    };
  }

  private state(provider: string): ProviderState {
    let state = this.providers.get(provider);
    if (!state) {
      state = this.newState(this.defaultLimit);
      this.providers.set(provider, state);
    }
    return state;
  }

  private refill(state: ProviderState): void {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - state.updatedAt);
    state.tokens = Math.min(state.capacity, state.tokens + elapsed * state.rate);
    state.updatedAt = now;
  }

  private drain(state: ProviderState): void {
    this.refill(state);
    const now = this.clock.now();
    while (now >= state.pausedUntil && state.tokens >= 1 - EPSILON) {
      const waiter = state.interactive.shift() ?? state.background.shift();
      if (!waiter) break;
      state.tokens = Math.max(0, state.tokens - 1);
      waiter.cleanup();
      waiter.resolve();
    }
    if (state.armed || state.interactive.length + state.background.length === 0) return;
    const tokenWait = state.tokens >= 1 - EPSILON ? 0 : Math.ceil((1 - state.tokens) / state.rate);
    const wait = Math.max(1, state.pausedUntil - now, tokenWait);
    state.armed = true;
    void this.clock.sleep(wait).then(() => {
      state.armed = false;
      this.drain(state);
    });
  }
}

/** The process-wide limiter every client uses unless given another one. */
export const defaultRateLimiter = new RateLimiter();
