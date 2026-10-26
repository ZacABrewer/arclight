/**
 * Exponential moving average rate meter: each byte contributes `e^(-age/tau)/tau`, so a
 * steady stream of R bytes/s converges to R and an idle meter decays smoothly to 0.
 */
export class RateMeter {
  private value = 0;
  private last: number;
  total = 0;

  constructor(
    private readonly tauMs = 5000,
    private readonly now: () => number = Date.now,
  ) {
    this.last = now();
  }

  private decay(): void {
    const t = this.now();
    const dt = t - this.last;
    if (dt > 0) {
      this.value *= Math.exp(-dt / this.tauMs);
      this.last = t;
    }
  }

  add(bytes: number): void {
    this.decay();
    this.value += bytes / (this.tauMs / 1000);
    this.total += bytes;
  }

  /** Bytes per second. */
  rate(): number {
    this.decay();
    return this.value < 0.5 ? 0 : this.value;
  }
}

/**
 * Token bucket. `rate` is bytes/s (0 = unlimited). Consumption may go into debt; the caller
 * waits for the returned delay, which keeps large writes simple and the average exact.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private rateBps: number;

  constructor(
    rate = 0,
    private readonly burstSeconds = 1,
    private readonly now: () => number = Date.now,
  ) {
    this.rateBps = rate;
    this.tokens = this.capacity;
    this.last = now();
  }

  get rate(): number {
    return this.rateBps;
  }

  private get capacity(): number {
    return Math.max(this.rateBps * this.burstSeconds, 16 * 1024);
  }

  setRate(rate: number): void {
    this.refill();
    this.rateBps = Math.max(0, rate);
    this.tokens = Math.min(this.tokens, this.capacity);
  }

  private refill(): void {
    const t = this.now();
    if (this.rateBps > 0) this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.rateBps);
    this.last = t;
  }

  /** Takes `n` tokens and returns how many ms to wait before proceeding (0 when unlimited). */
  consume(n: number): number {
    if (this.rateBps <= 0) return 0;
    this.refill();
    this.tokens -= n;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rateBps) * 1000);
  }
}

/** Consumes from several buckets (e.g. per-connection and global) and returns the longest wait. */
export function consumeAll(buckets: readonly TokenBucket[], n: number): number {
  let wait = 0;
  for (const b of buckets) wait = Math.max(wait, b.consume(n));
  return wait;
}
