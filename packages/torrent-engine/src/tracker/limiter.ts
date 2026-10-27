import { TorrentEngineError } from '../errors.js';

/**
 * Caps tracker requests in flight across the whole process. Every announce is a socket (and,
 * behind a VPN, a NAT entry): with announce-to-all-tiers, a dozen active torrents listing 20+
 * trackers each opened hundreds at once on start, and dead trackers held theirs until they
 * timed out. Behind gluetun that flood stalled the tunnel. Requests beyond the cap wait.
 */
export class RequestLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(public max: number) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new TorrentEngineError('tracker', 'tracker request aborted'));
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const go = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = (): void => {
        const i = this.waiting.indexOf(go);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new TorrentEngineError('tracker', 'tracker request aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(go);
    });
  }

  private release(): void {
    this.active--;
    while (this.active < this.max && this.waiting.length > 0) this.waiting.shift()?.();
  }
}

/** Shared by every HTTP and UDP tracker client (one engine per process). */
export const trackerRequests = new RequestLimiter(24);
