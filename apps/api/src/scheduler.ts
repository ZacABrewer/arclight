import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Job, JobTrigger, ScheduledJob } from '@arclight/shared';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { EventBus } from './events.js';

export type JobHandler = (ctx: { signal: AbortSignal; log: Logger }) => Promise<string | void>;

export interface JobDefinition {
  name: string;
  /** Cron expression. Omit for jobs that only run on demand. */
  cron?: string;
  handler: JobHandler;
}

// A deliberately small scheduler: one job of a given name runs at a time, every run is a
// row in `jobs` so history survives restarts, and each state change is published on the
// bus so the UI shows it live. Modules register definitions at startup.
export class Scheduler {
  private readonly definitions = new Map<string, JobDefinition>();
  private readonly crons = new Map<string, Cron>();
  private readonly running = new Map<string, AbortController>();
  private started = false;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  register(def: JobDefinition): void {
    if (this.definitions.has(def.name)) throw new Error(`job already registered: ${def.name}`);
    this.definitions.set(def.name, def);
    if (def.cron) {
      this.db
        .insert(schema.scheduledJobs)
        .values({ name: def.name, interval: def.cron })
        .onConflictDoUpdate({ target: schema.scheduledJobs.name, set: { interval: def.cron } })
        .run();
    }
  }

  start(): void {
    // Anything left "running" from a previous process died with it.
    this.db
      .update(schema.jobs)
      .set({ status: 'failed', message: 'interrupted by restart', endedAt: now() })
      .where(eq(schema.jobs.status, 'running'))
      .run();

    this.started = true;
    for (const def of this.definitions.values()) this.schedule(def);
    this.log.info({ jobs: [...this.crons.keys()] }, 'scheduler started');
  }

  private schedule(def: JobDefinition): void {
    if (!def.cron) return;
    const row = this.db.select().from(schema.scheduledJobs).where(eq(schema.scheduledJobs.name, def.name)).get();
    if (row && !row.enabled) return;
    const cron = new Cron(def.cron, { protect: true }, () => void this.run(def.name, 'scheduled'));
    this.crons.set(def.name, cron);
  }

  stop(): void {
    this.started = false;
    for (const cron of this.crons.values()) cron.stop();
    for (const ctrl of this.running.values()) ctrl.abort();
  }

  /**
   * Change a registered job's schedule. `null` makes it on-demand only (no cron). When the
   * scheduler is running the timer is replaced immediately; a run in progress is not affected.
   */
  update(name: string, cron: string | null): void {
    const def = this.definitions.get(name);
    if (!def) throw new Error(`unknown job: ${name}`);
    if (cron !== null) new Cron(cron, { paused: true }).stop(); // validate before touching state
    const next: JobDefinition = { name: def.name, handler: def.handler, ...(cron !== null ? { cron } : {}) };
    this.definitions.set(name, next);
    if (cron !== null) {
      this.db
        .insert(schema.scheduledJobs)
        .values({ name, interval: cron })
        .onConflictDoUpdate({ target: schema.scheduledJobs.name, set: { interval: cron } })
        .run();
    }
    this.crons.get(name)?.stop();
    this.crons.delete(name);
    if (this.started && cron !== null) this.schedule(next);
  }

  listScheduled(): ScheduledJob[] {
    return [...this.definitions.values()]
      .filter((d) => d.cron)
      .map((d) => {
        const row = this.db.select().from(schema.scheduledJobs).where(eq(schema.scheduledJobs.name, d.name)).get();
        const next = this.crons.get(d.name)?.nextRun() ?? null;
        return {
          name: d.name,
          interval: d.cron!,
          lastRun: row?.lastRun ?? null,
          nextRun: next ? next.toISOString() : null,
          enabled: row?.enabled ?? true,
        };
      });
  }

  listRecent(limit = 50): Job[] {
    return this.db
      .select()
      .from(schema.jobs)
      .orderBy((t) => t.id)
      .all()
      .slice(-limit)
      .reverse()
      .map(toJob);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  async run(name: string, trigger: JobTrigger): Promise<Job> {
    const def = this.definitions.get(name);
    if (!def) throw new Error(`unknown job: ${name}`);
    if (this.running.has(name)) {
      const row = this.insert({ name, trigger, status: 'cancelled', message: 'already running' });
      this.bus.publish({ type: 'job', job: row });
      return row;
    }

    const ctrl = new AbortController();
    this.running.set(name, ctrl);
    let job = this.insert({ name, trigger, status: 'running', startedAt: now() });
    this.bus.publish({ type: 'job', job });
    const log = this.log.child({ job: name, jobId: job.id });

    try {
      const message = await def.handler({ signal: ctrl.signal, log });
      job = this.finish(job.id, 'completed', message ?? null);
    } catch (err) {
      log.error({ err }, 'job failed');
      job = this.finish(job.id, ctrl.signal.aborted ? 'cancelled' : 'failed', errorMessage(err));
    } finally {
      this.running.delete(name);
      if (def.cron) {
        this.db.update(schema.scheduledJobs).set({ lastRun: now() }).where(eq(schema.scheduledJobs.name, name)).run();
      }
    }
    this.bus.publish({ type: 'job', job });
    return job;
  }

  private insert(values: {
    name: string;
    trigger: JobTrigger;
    status: Job['status'];
    message?: string;
    startedAt?: string;
  }): Job {
    const queuedAt = now();
    const isTerminal = values.status !== 'running' && values.status !== 'queued';
    const row = this.db
      .insert(schema.jobs)
      .values({
        name: values.name,
        trigger: values.trigger,
        status: values.status,
        message: values.message ?? null,
        queuedAt,
        startedAt: values.startedAt ?? null,
        endedAt: isTerminal ? queuedAt : null,
      })
      .returning()
      .get();
    return toJob(row);
  }

  private finish(id: number, status: Job['status'], message: string | null): Job {
    const row = this.db
      .update(schema.jobs)
      .set({ status, message, endedAt: now() })
      .where(eq(schema.jobs.id, id))
      .returning()
      .get();
    if (!row) throw new Error(`job row vanished: ${id}`);
    return toJob(row);
  }
}

function toJob(row: typeof schema.jobs.$inferSelect): Job {
  const durationMs =
    row.startedAt && row.endedAt ? new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime() : null;
  return { ...row, durationMs };
}

function now(): string {
  return new Date().toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
