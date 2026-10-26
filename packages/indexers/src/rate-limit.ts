export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Space calls at least `intervalMs` apart. Each caller reserves the next slot before
 * waiting, so concurrent callers queue in order instead of firing together.
 */
export function createRateLimiter(
  intervalMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): () => Promise<void> {
  let nextSlot = 0;
  return async () => {
    if (intervalMs <= 0) return;
    const current = now();
    const wait = Math.max(0, nextSlot - current);
    nextSlot = Math.max(current, nextSlot) + intervalMs;
    if (wait > 0) await sleep(wait);
  };
}
