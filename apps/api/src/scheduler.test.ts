import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import { createTestDb } from './db/test-utils.js';
import { EventBus } from './events.js';
import { Scheduler } from './scheduler.js';

let scheduler: Scheduler | undefined;

async function make(): Promise<{ db: Db; scheduler: Scheduler }> {
  const db = await createTestDb();
  scheduler = new Scheduler(db, new EventBus(), pino({ level: 'silent' }));
  return { db, scheduler };
}

afterEach(() => scheduler?.stop());

describe('Scheduler.update', () => {
  it('changes the cron of a registered job and persists the interval', async () => {
    const { db, scheduler } = await make();
    scheduler.register({ name: 'Job', cron: '*/15 * * * *', handler: async () => 'ok' });
    scheduler.update('Job', '*/30 * * * *');
    expect(scheduler.listScheduled()).toMatchObject([{ name: 'Job', interval: '*/30 * * * *' }]);
    expect(db.select().from(schema.scheduledJobs).where(eq(schema.scheduledJobs.name, 'Job')).get()?.interval).toBe('*/30 * * * *');
  });

  it('replaces the running timer once started', async () => {
    const { scheduler } = await make();
    scheduler.register({ name: 'Job', cron: '0 0 1 1 *', handler: async () => 'ok' });
    scheduler.start();
    const before = scheduler.listScheduled()[0]!.nextRun!;
    scheduler.update('Job', '* * * * *');
    const after = scheduler.listScheduled()[0]!.nextRun!;
    expect(Date.parse(after)).toBeLessThan(Date.parse(before));
    expect(Date.parse(after) - Date.now()).toBeLessThanOrEqual(60_000);
  });

  it('makes a job on-demand with null and schedules it again later', async () => {
    const { scheduler } = await make();
    scheduler.register({ name: 'Job', cron: '*/15 * * * *', handler: async () => 'ran' });
    scheduler.start();
    scheduler.update('Job', null);
    expect(scheduler.listScheduled()).toEqual([]);
    expect(scheduler.has('Job')).toBe(true);
    expect((await scheduler.run('Job', 'manual')).message).toBe('ran');
    scheduler.update('Job', '*/10 * * * *');
    expect(scheduler.listScheduled()[0]).toMatchObject({ interval: '*/10 * * * *' });
    expect(scheduler.listScheduled()[0]!.nextRun).not.toBeNull();
  });

  it('rejects unknown jobs and invalid cron without changing anything', async () => {
    const { scheduler } = await make();
    scheduler.register({ name: 'Job', cron: '*/15 * * * *', handler: async () => 'ok' });
    expect(() => scheduler.update('Nope', '* * * * *')).toThrow(/unknown job/);
    expect(() => scheduler.update('Job', 'not a cron')).toThrow();
    expect(scheduler.listScheduled()[0]!.interval).toBe('*/15 * * * *');
  });
});

describe('Scheduler.runTask', () => {
  it('records an ad-hoc task as a job row with bus events and resolves the final row', async () => {
    const db = await createTestDb();
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => {
      if (e.type === 'job') seen.push(`${e.job.name}:${e.job.status}`);
    });
    scheduler = new Scheduler(db, bus, pino({ level: 'silent' }));
    const { job, done } = scheduler.runTask('RefreshSeriesItem', 'manual', async () => 'refreshed 1 of 1 series');
    expect(job).toMatchObject({ name: 'RefreshSeriesItem', status: 'running', trigger: 'manual' });
    expect(await done).toMatchObject({ id: job.id, status: 'completed', message: 'refreshed 1 of 1 series' });
    expect(seen).toEqual(['RefreshSeriesItem:running', 'RefreshSeriesItem:completed']);
    expect(scheduler.listRecent()[0]).toMatchObject({ id: job.id, status: 'completed' });
    // Ad-hoc tasks are not registered jobs.
    expect(scheduler.has('RefreshSeriesItem')).toBe(false);
  });

  it('runs one task per key at a time; different keys overlap', async () => {
    const { scheduler } = await make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = scheduler.runTask('Refresh', 'manual', async () => gate.then(() => 'one'), { key: 'Refresh:1' });
    const dup = scheduler.runTask('Refresh', 'manual', async () => 'dup', { key: 'Refresh:1' });
    const other = scheduler.runTask('Refresh', 'manual', async () => 'two', { key: 'Refresh:2' });
    expect(dup.job).toMatchObject({ status: 'cancelled', message: 'already running' });
    expect((await other.done).message).toBe('two');
    release();
    expect((await first.done).message).toBe('one');
    // The key is free again once the task finished.
    expect((await scheduler.runTask('Refresh', 'manual', async () => 'again', { key: 'Refresh:1' }).done).status).toBe('completed');
  });

  it('marks a throwing task failed with its message', async () => {
    const { scheduler } = await make();
    const { done } = scheduler.runTask('Boom', 'system', async () => {
      throw new Error('TMDB said no');
    });
    expect(await done).toMatchObject({ status: 'failed', message: 'TMDB said no', trigger: 'system' });
  });
});
