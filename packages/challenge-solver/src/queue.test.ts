import { describe, expect, it } from 'vitest';
import { SerialQueue } from './queue.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SerialQueue', () => {
  it('runs one task at a time in submission order', async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    let concurrent = 0;
    let peak = 0;
    const task = (name: string, ms: number) => async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      log.push('start ' + name);
      await tick(ms);
      log.push('end ' + name);
      concurrent -= 1;
      return name;
    };
    const results = await Promise.all([q.run(task('a', 20)), q.run(task('b', 1)), q.run(task('c', 5))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(peak).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('keeps going after a failing task', async () => {
    const q = new SerialQueue();
    const failed = q.run(async () => {
      throw new Error('boom');
    });
    const next = q.run(async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('reports size and fires onIdle when drained', async () => {
    const q = new SerialQueue();
    let idle = 0;
    q.onIdle(() => idle++);
    const a = q.run(() => tick(5));
    const b = q.run(() => tick(5));
    expect(q.size).toBe(2);
    await Promise.all([a, b]);
    expect(q.size).toBe(0);
    expect(idle).toBe(1);
  });
});
