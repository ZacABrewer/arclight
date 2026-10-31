import { describe, expect, it } from 'vitest';
import { DISK_WRITES_IN_FLIGHT, DiskIo, Semaphore } from './io.js';

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('Semaphore', () => {
  it('runs at most `limit` tasks, in arrival order, and starts waiters when the limit rises', async () => {
    const s = new Semaphore(2);
    const started: number[] = [];
    const gates = [0, 1, 2, 3].map(() => gate());
    const runs = gates.map((g, i) => s.run(async () => {
      started.push(i);
      await g.promise;
    }));
    await tick();
    expect(started).toEqual([0, 1]);
    expect(s.queued).toBe(2);
    gates[1]!.open();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    s.limit = 3;
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    for (const g of gates) g.open();
    await Promise.all(runs);
    expect(s.active).toBe(0);
  });

  it('drops a waiter whose signal aborts', async () => {
    const s = new Semaphore(1);
    const release = await s.acquire();
    const ctl = new AbortController();
    const waiting = s.acquire(ctl.signal);
    ctl.abort(new Error('closed'));
    await expect(waiting).rejects.toThrow('closed');
    expect(s.queued).toBe(0);
    release();
    expect(s.active).toBe(0);
  });
});

describe('DiskIo', () => {
  it('bounds writes in flight and counts the bytes written', async () => {
    const io = new DiskIo();
    const g = gate();
    let inFlight = 0;
    let peak = 0;
    const writes = Array.from({ length: DISK_WRITES_IN_FLIGHT + 4 }, () =>
      io.write(100, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await g.promise;
        inFlight--;
      }),
    );
    await tick();
    expect(io.queuedWrites).toBe(4);
    g.open();
    await Promise.all(writes);
    expect(peak).toBe(DISK_WRITES_IN_FLIGHT);
    expect(io.writtenBytes).toBe(100 * (DISK_WRITES_IN_FLIGHT + 4));
    expect(io.queuedWrites).toBe(0);
  });
});
