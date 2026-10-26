import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Job, JobTrigger } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import { jobs } from '../../db/schema.js';
import { CompatError, type Json } from './common.js';
import { toV3Command } from './activity.js';

// POST /api/v3/command. Upstream commands become either a run of a registered scheduler job
// (RssSync, MissingEpisodeSearch ...) or a targeted piece of work (search one series, refresh
// one movie). Both are rows in the `jobs` table, so GET /command/:id answers from there and
// the UI's job list shows them too.

export type CommandWork = (signal: AbortSignal) => Promise<string | void>;

/** What a command resolves to. */
export type CommandPlan = { kind: 'job'; job: string } | { kind: 'work'; work: CommandWork };

/** Resolves a command name + body to a plan, or null for unknown commands. */
export type CommandResolver = (name: string, body: Json) => CommandPlan | null;

interface Requested {
  name: string;
  body: Json;
}

export class CommandRunner {
  /** Name and body as the client sent them (the jobs table only keeps the job name). */
  private readonly requested = new Map<number, Requested>();
  private readonly controllers = new Map<number, AbortController>();

  constructor(
    private readonly ctx: AppContext,
    private readonly resolve: CommandResolver,
  ) {}

  /** Starts a command and returns its resource (status `started`, or terminal if it was refused). */
  start(name: string, body: Json, trigger: JobTrigger = 'manual'): Json {
    const plan = this.resolve(name, body);
    if (!plan) throw CompatError.validation('name', `Unknown command: ${name}`, name);
    const job = plan.kind === 'job' ? this.startJob(plan.job) : this.startWork(name, plan.work, trigger);
    this.remember(job.id, { name, body });
    return toV3Command(job, { name, body });
  }

  get(id: number): Json | null {
    const row = this.ctx.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? toV3Command(toJob(row), this.requested.get(id)) : null;
  }

  /** Recent commands, newest first. */
  list(limit = 50): Json[] {
    return this.ctx.db
      .select()
      .from(jobs)
      .orderBy(desc(jobs.id))
      .limit(limit)
      .all()
      .map((row) => toV3Command(toJob(row), this.requested.get(row.id)));
  }

  /** Cancels targeted work (scheduler jobs cannot be cancelled from here). */
  cancel(id: number): boolean {
    const ctrl = this.controllers.get(id);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  private remember(id: number, requested: Requested): void {
    this.requested.set(id, requested);
    // Bounded: the oldest entries go first (Map keeps insertion order).
    while (this.requested.size > 500) {
      const oldest = this.requested.keys().next().value;
      if (oldest === undefined) break;
      this.requested.delete(oldest);
    }
  }

  /** Runs a registered job; the scheduler inserts (and publishes) its row synchronously. */
  private startJob(name: string): Job {
    const captured: { job: Job | null } = { job: null };
    const unsubscribe = this.ctx.bus.subscribe((event) => {
      if (!captured.job && event.type === 'job' && event.job.name === name) captured.job = event.job;
    });
    try {
      void this.ctx.scheduler.run(name, 'manual').catch((err: unknown) => this.ctx.log.warn({ err, job: name }, 'compat command failed'));
    } finally {
      unsubscribe();
    }
    if (captured.job) return captured.job;
    // Fallback: the newest row for that job.
    const row = this.ctx.db.select().from(jobs).where(eq(jobs.name, name)).orderBy(desc(jobs.id)).limit(1).get();
    if (!row) throw new CompatError(500, `job ${name} did not start`);
    return toJob(row);
  }

  private startWork(name: string, work: CommandWork, trigger: JobTrigger): Job {
    const db = this.ctx.db;
    const now = new Date().toISOString();
    const row = db.insert(jobs).values({ name, trigger, status: 'running', message: null, queuedAt: now, startedAt: now, endedAt: null }).returning().get();
    const job = toJob(row);
    this.ctx.bus.publish({ type: 'job', job });
    const ctrl = new AbortController();
    this.controllers.set(job.id, ctrl);
    const finish = (status: Job['status'], message: string | null) => {
      this.controllers.delete(job.id);
      const done = db.update(jobs).set({ status, message, endedAt: new Date().toISOString() }).where(eq(jobs.id, job.id)).returning().get();
      if (done) this.ctx.bus.publish({ type: 'job', job: toJob(done) });
    };
    // Detached; progress is visible through GET /command/:id and the event feed.
    void Promise.resolve()
      .then(() => work(ctrl.signal))
      .then(
        (message) => finish('completed', message ?? null),
        (err: unknown) => {
          this.ctx.log.warn({ err, command: name }, 'compat command failed');
          finish(ctrl.signal.aborted ? 'cancelled' : 'failed', err instanceof Error ? err.message : String(err));
        },
      );
    return job;
  }
}

function toJob(row: typeof jobs.$inferSelect): Job {
  const durationMs = row.startedAt && row.endedAt ? Date.parse(row.endedAt) - Date.parse(row.startedAt) : null;
  return { ...row, durationMs };
}

// ---- command bodies ----------------------------------------------------------------------

const ids = z.array(z.coerce.number().int().positive());
const id = z.coerce.number().int().positive();

export const CommandBodies = {
  seriesId: z.object({ seriesId: id }),
  optionalSeriesId: z.object({ seriesId: id.optional(), seriesIds: ids.optional() }),
  season: z.object({ seriesId: id, seasonNumber: z.coerce.number().int().min(0) }),
  episodes: z.object({ episodeIds: ids.min(1) }),
  movies: z.object({ movieIds: ids.min(1) }),
  optionalMovies: z.object({ movieIds: ids.optional(), movieId: id.optional() }),
  renameSeries: z.object({ seriesId: id, files: ids.optional() }),
  renameMovie: z.object({ movieId: id, files: ids.optional() }),
  renameSeriesMany: z.object({ seriesIds: ids.min(1) }),
  renameMovieMany: z.object({ movieIds: ids.min(1) }),
  manualImport: z.object({
    importMode: z.string().optional(),
    files: z
      .array(
        z.object({
          path: z.string().min(1),
          seriesId: id.optional(),
          seasonNumber: z.coerce.number().int().optional(),
          episodeIds: ids.optional(),
          movieId: id.optional(),
          quality: z.unknown().optional(),
          languages: z.array(z.object({ id: z.number().int() })).optional(),
          releaseGroup: z.string().nullish(),
          downloadId: z.string().optional(),
        }),
      )
      .min(1),
  }),
} as const;
