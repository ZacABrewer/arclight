/**
 * Runs async tasks one at a time in submission order (the solver drives a single browser, so
 * concurrency is 1). A failing task does not stop the queue.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private running = false;
  private readonly idleListeners = new Set<() => void>();

  /** Tasks submitted but not yet finished (including the running one). */
  get size(): number {
    return this.waiting;
  }

  get active(): boolean {
    return this.running;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.waiting += 1;
    const result = this.tail.then(async () => {
      this.running = true;
      try {
        return await task();
      } finally {
        this.running = false;
        this.waiting -= 1;
        if (this.waiting === 0) for (const l of this.idleListeners) l();
      }
    });
    // Keep the chain alive past failures; the caller still sees the rejection.
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Called whenever the queue drains. Returns unsubscribe. */
  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => this.idleListeners.delete(listener);
  }
}
