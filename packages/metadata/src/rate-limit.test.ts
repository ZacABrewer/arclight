import { describe, expect, it } from 'vitest';
import { RateLimiter, computeBackoffMs } from './rate-limit.js';
import { createManualClock, flush } from './music-test-support.js';
import { jsonResponse } from './test-support.js';

function setup(rps = 1, burst = 1) {
  const clock = createManualClock(0);
  const limiter = new RateLimiter({ clock, random: () => 0 });
  limiter.configure('p', { requestsPerSecond: rps, burst });
  return { clock, limiter };
}

describe('RateLimiter', () => {
  it('spaces requests at 1 per second', async () => {
    const { clock, limiter } = setup();
    const times: number[] = [];
    const all = [0, 1, 2, 3].map(() => limiter.acquire('p').then(() => times.push(clock.now())));
    await clock.advance(5_000);
    await Promise.all(all);
    expect(times).toEqual([0, 1000, 2000, 3000]);
  });

  it('does not let a request out early', async () => {
    const { clock, limiter } = setup();
    await limiter.acquire('p');
    let done = false;
    void limiter.acquire('p').then(() => (done = true));
    await clock.advance(999);
    expect(done).toBe(false);
    await clock.advance(1);
    expect(done).toBe(true);
  });

  it('allows a burst and a higher configured rate', async () => {
    const { clock, limiter } = setup(4, 2);
    const times: number[] = [];
    const all = [0, 1, 2, 3].map(() => limiter.acquire('p').then(() => times.push(clock.now())));
    await clock.advance(2_000);
    await Promise.all(all);
    expect(times).toEqual([0, 0, 250, 500]);
    expect(limiter.limitOf('p')).toEqual({ requestsPerSecond: 4, burst: 2 });
  });

  it('keeps providers independent', async () => {
    const { clock, limiter } = setup();
    limiter.configure('q', { requestsPerSecond: 1 });
    const times: string[] = [];
    const all = [
      limiter.acquire('p').then(() => times.push(`p@${clock.now()}`)),
      limiter.acquire('q').then(() => times.push(`q@${clock.now()}`)),
      limiter.acquire('p').then(() => times.push(`p@${clock.now()}`)),
    ];
    await clock.advance(2_000);
    await Promise.all(all);
    expect(times).toEqual(['p@0', 'q@0', 'p@1000']);
  });

  it('serves interactive requests before queued background ones', async () => {
    const { clock, limiter } = setup();
    const order: string[] = [];
    const take = (name: string, priority: 'interactive' | 'background') =>
      limiter.acquire('p', { priority }).then(() => order.push(name));
    const all = [
      take('bg1', 'background'),
      take('bg2', 'background'),
      take('bg3', 'background'),
      take('ui1', 'interactive'),
      take('ui2', 'interactive'),
    ];
    expect(limiter.pending('p')).toBe(4);
    await clock.advance(10_000);
    await Promise.all(all);
    // bg1 had the free token; afterwards both interactive requests overtake bg2/bg3.
    expect(order).toEqual(['bg1', 'ui1', 'ui2', 'bg2', 'bg3']);
  });

  it('rejects an aborted waiter without spending a token', async () => {
    const { clock, limiter } = setup();
    await limiter.acquire('p');
    const controller = new AbortController();
    const aborted = limiter.acquire('p', { signal: controller.signal });
    const times: number[] = [];
    const next = limiter.acquire('p').then(() => times.push(clock.now()));
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(limiter.pending('p')).toBe(1);
    await clock.advance(1_000);
    await next;
    expect(times).toEqual([1000]);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const { limiter } = setup();
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(limiter.acquire('p', { signal: controller.signal })).rejects.toThrow('gone');
  });

  it('backs off on 503 honouring Retry-After, pausing the whole provider', async () => {
    const { clock, limiter } = setup();
    const sent: number[] = [];
    let calls = 0;
    const first = limiter.schedule('p', async () => {
      sent.push(clock.now());
      calls += 1;
      return calls === 1 ? jsonResponse({}, 503, { 'retry-after': '5' }) : jsonResponse({ ok: true });
    });
    await flush();
    // Queued behind the throttled request; must also wait out the pause.
    const otherAt: number[] = [];
    const other = limiter.acquire('p').then(() => otherAt.push(clock.now()));
    await clock.advance(10_000);
    const response = await first;
    await other;
    expect(response.status).toBe(200);
    expect(sent).toEqual([0, 5000]);
    expect(otherAt[0]).toBeGreaterThanOrEqual(5000);
  });

  it('backs off exponentially on 429 without Retry-After and gives up after maxRetries', async () => {
    const { clock, limiter } = setup(100, 1);
    const sent: number[] = [];
    const done = limiter.schedule(
      'p',
      async () => {
        sent.push(clock.now());
        return jsonResponse({}, 429);
      },
      { maxRetries: 2 },
    );
    await clock.advance(60_000);
    const response = await done;
    expect(response.status).toBe(429);
    // random() = 0 → delays of base/2 · 2^attempt: 500, then 1000.
    expect(sent).toEqual([0, 500, 1500]);
  });

  it('stops retrying when aborted during a backoff', async () => {
    const { clock, limiter } = setup();
    const controller = new AbortController();
    const done = limiter.schedule('p', async () => jsonResponse({}, 503, { 'retry-after': '30' }), {
      signal: controller.signal,
    });
    await clock.advance(1_000);
    controller.abort();
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('computeBackoffMs', () => {
  it('uses Retry-After plus bounded jitter', () => {
    expect(computeBackoffMs(0, 3000, { random: () => 0 })).toBe(3000);
    expect(computeBackoffMs(0, 3000, { random: () => 0.999 })).toBe(3499);
  });

  it('grows exponentially with equal jitter and is capped', () => {
    expect(computeBackoffMs(0, undefined, { random: () => 0 })).toBe(500);
    expect(computeBackoffMs(2, undefined, { random: () => 0 })).toBe(2000);
    expect(computeBackoffMs(2, undefined, { random: () => 0.5 })).toBe(3000);
    expect(computeBackoffMs(30, undefined, { random: () => 0.999, maxMs: 10_000 })).toBeLessThanOrEqual(10_000);
    expect(computeBackoffMs(0, 10 * 60_000, { random: () => 0, maxMs: 60_000 })).toBe(60_000);
  });
});
