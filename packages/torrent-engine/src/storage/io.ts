/**
 * A counting semaphore: at most `limit` tasks run at once, the rest wait (by priority, then in
 * arrival order).
 * The limit can change at runtime (raising it starts waiting tasks right away).
 */
export class Semaphore {
  private running = 0;
  private readonly waiting: { start: () => void; priority: number; onAbort: () => void }[] = [];

  constructor(private limitValue: number) {}

  get limit(): number {
    return this.limitValue;
  }

  set limit(n: number) {
    this.limitValue = Math.max(1, Math.floor(n));
    this.pump();
  }

  /** Tasks running now. */
  get active(): number {
    return this.running;
  }

  /** Tasks waiting for a slot. */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Waits for a slot and returns its release function (call it exactly once). Waiters are
   * served by `priority` (lower first), then in arrival order. An aborted `signal` drops the
   * waiter and rejects with the signal's reason.
   */
  acquire(signal?: AbortSignal, priority = 0): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.running--;
        this.pump();
      };
      const entry = {
        priority,
        start: () => {
          signal?.removeEventListener('abort', entry.onAbort);
          this.running++;
          resolve(release);
        },
        onAbort: () => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(signal?.reason);
        },
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      const at = this.waiting.findIndex((w) => w.priority > priority);
      if (at < 0) this.waiting.push(entry);
      else this.waiting.splice(at, 0, entry);
      this.pump();
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private pump(): void {
    while (this.running < this.limitValue && this.waiting.length > 0) this.waiting.shift()?.start();
  }
}

/**
 * Disk writes in flight at once, session-wide (see DiskIo). The Docker image raises the libuv
 * threadpool to 16 threads (UV_THREADPOOL_SIZE), so writes never hold more than a quarter of it.
 */
export const DISK_WRITES_IN_FLIGHT = 4;

/**
 * The session's disk writes: a bound on writes in flight and what they achieved. Node runs
 * every file read and write (and DNS lookups) on the libuv threadpool, which is small. Issued
 * all at once, a few hundred queued block writes on a disk that falls behind filled it, and a
 * seeding read or a tracker's DNS lookup waited behind all of them: uploads stopped whenever
 * downloads outran the disk. Writes beyond the bound wait here instead, still counted in each
 * torrent's write backlog, so the threadpool always has room for the rest.
 */
export class DiskIo {
  private readonly slots = new Semaphore(DISK_WRITES_IN_FLIGHT);
  private written = 0;
  private latencyMs = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Bytes written to disk so far (completed writes, failed ones included). */
  get writtenBytes(): number {
    return this.written;
  }

  /** Moving average of one write's time on disk, in ms (0 before the first). */
  get writeLatencyMs(): number {
    return this.latencyMs;
  }

  /** Writes waiting for a slot. */
  get queuedWrites(): number {
    return this.slots.queued;
  }

  /** Runs one write of `bytes` when a slot is free and records how it went. */
  async write<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
    const release = await this.slots.acquire();
    const started = this.now();
    try {
      return await fn();
    } finally {
      const ms = this.now() - started;
      this.latencyMs = this.latencyMs === 0 ? ms : this.latencyMs * 0.9 + ms * 0.1;
      this.written += bytes;
      release();
    }
  }
}
