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
