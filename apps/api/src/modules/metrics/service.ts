import { monitorEventLoopDelay } from 'node:perf_hooks';
import { and, count, eq, gte, sql, sum } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ServerEvent } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import {
  downloadClients,
  episodes,
  indexers,
  indexerStats,
  indexerStatus,
  mediaFiles,
  mediaRequests,
  movies,
  series,
  trackedDownloads,
} from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { VERSION } from '../../version.js';
import { Registry, type Counter, type Gauge, type Histogram } from './registry.js';

/**
 * Live values owned by other modules' services. Each is optional and may throw; production
 * wires them to the per-context services (index.ts), tests pass fakes.
 */
export interface MetricsSources {
  /** Built-in torrent engine, null when it is not running. */
  torrent?: () => { state: string; downloadRate: number; uploadRate: number; peers: number } | null;
  vpn?: () => { enabled: boolean; connected: boolean } | null;
  /** Number of wanted subtitles (expensive: cached for `slowTtlMs`). */
  subtitlesWanted?: () => number | null;
  /** Last refresh result per download client id. */
  clientStatuses?: () => ReadonlyMap<number, { ok: boolean }>;
}

export interface MetricsServiceOptions {
  db: Db;
  bus?: EventBus;
  log?: Logger;
  sources?: MetricsSources;
  now?: () => number;
  /** Cache time for expensive collectors. Default 5 minutes. */
  slowTtlMs?: number;
}

const HOUR_MS = 3_600_000;
const JOB_BUCKETS = [0.1, 0.5, 1, 5, 15, 30, 60, 300, 900, 1800, 3600];

/** Route label for a request: the matched pattern, never the raw URL (bounded cardinality). */
export function routeLabel(req: FastifyRequest): string {
  return req.routeOptions?.url ?? '(unmatched)';
}

export class MetricsService {
  readonly registry = new Registry();
  private readonly db: Db;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private readonly sources: MetricsSources;
  private readonly now: () => number;
  private readonly slowTtlMs: number;
  private readonly started = new WeakMap<FastifyRequest, bigint>();
  private readonly runningJobs = new Map<number, string>();
  private unsubscribe: (() => void) | undefined;
  private loop: ReturnType<typeof monitorEventLoopDelay> | undefined;
  private wantedCache: { at: number; value: number | null } | undefined;
  /** Previous per-client byte totals for the estimated download rate. */
  private clientBytes: { at: number; bytes: Map<number, number> } | undefined;

  readonly httpRequests: Counter;
  readonly httpDuration: Histogram;
  readonly jobRuns: Counter;
  readonly jobFailures: Counter;
  readonly jobDuration: Histogram;
  readonly jobsRunning: Gauge;
  readonly releasesGrabbed: Counter;
  readonly imports: Counter;
  private readonly g: Record<string, Gauge> = {};
  private readonly cpu: { user: Counter; system: Counter; total: Counter };

  constructor(opts: MetricsServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.sources = opts.sources ?? {};
    this.now = opts.now ?? Date.now;
    this.slowTtlMs = opts.slowTtlMs ?? 5 * 60_000;
    const r = this.registry;

    r.gauge('arclight_info', 'Build information.').set({ version: VERSION, node: process.version }, 1);
    this.httpRequests = r.counter('arclight_http_requests_total', 'HTTP requests by method, route pattern and status code.');
    this.httpDuration = r.histogram('arclight_http_request_duration_seconds', 'HTTP request duration by method and route pattern.');
    this.jobRuns = r.counter('arclight_job_runs_total', 'Finished job runs by job name and final status.');
    this.jobFailures = r.counter('arclight_job_failures_total', 'Failed job runs by job name.');
    this.jobDuration = r.histogram('arclight_job_duration_seconds', 'Job run duration by job name.', JOB_BUCKETS);
    this.jobsRunning = r.gauge('arclight_jobs_running', 'Jobs running now, by job name.');
    this.releasesGrabbed = r.counter('arclight_releases_grabbed_total', 'Releases sent to a download client since start.');
    this.imports = r.counter('arclight_imports_total', 'Import outcomes since start, by result.');

    const gauge = (name: string, help: string) => (this.g[name] = r.gauge(name, help));
    this.cpu = {
      user: r.counter('process_cpu_user_seconds_total', 'User CPU time spent, in seconds.'),
      system: r.counter('process_cpu_system_seconds_total', 'System CPU time spent, in seconds.'),
      total: r.counter('process_cpu_seconds_total', 'Total user and system CPU time spent, in seconds.'),
    };
    gauge('process_resident_memory_bytes', 'Resident memory size in bytes.');
    gauge('nodejs_heap_size_total_bytes', 'V8 heap size in bytes.');
    gauge('nodejs_heap_size_used_bytes', 'V8 heap used in bytes.');
    gauge('nodejs_external_memory_bytes', 'Memory used by C++ objects bound to JavaScript, in bytes.');
    gauge('nodejs_eventloop_lag_p99_seconds', 'Event loop delay, 99th percentile since the last scrape.');
    gauge('process_start_time_seconds', 'Process start time, seconds since the Unix epoch.');
    gauge('process_uptime_seconds', 'Process uptime in seconds.');
    gauge('arclight_queue_items', 'Tracked downloads by state.');
    gauge('arclight_library_series', 'Series in the library.');
    gauge('arclight_library_movies', 'Movies in the library, by has_file.');
    gauge('arclight_library_episodes', 'Episodes, by monitored and has_file.');
    gauge('arclight_library_files', 'Media files on disk.');
    gauge('arclight_library_size_bytes', 'Total size of media files in bytes.');
    gauge('arclight_indexer_queries_24h', 'Indexer search queries in the last 24 h, by indexer and result.');
    gauge('arclight_indexer_rss_24h', 'Indexer RSS fetches in the last 24 h, by indexer and result.');
    gauge('arclight_indexer_grabs_24h', 'Grabs per indexer in the last 24 h, by indexer and result.');
    gauge('arclight_indexer_failures_24h', 'Failed indexer requests (any kind) in the last 24 h, by indexer.');
    gauge('arclight_indexer_response_seconds_avg_24h', 'Average indexer response time over the last 24 h, by indexer.');
    gauge('arclight_indexer_disabled', '1 while an indexer is backed off after failures, by indexer.');
    gauge('arclight_torrent_engine_up', '1 while the built-in torrent engine runs.');
    gauge('arclight_torrent_download_rate_bytes', 'Built-in torrent engine download rate, bytes per second.');
    gauge('arclight_torrent_upload_rate_bytes', 'Built-in torrent engine upload rate, bytes per second.');
    gauge('arclight_torrent_peers', 'Peers connected to the built-in torrent engine.');
    gauge('arclight_download_client_up', '1 when the last queue refresh reached the client, by client.');
    gauge('arclight_download_client_rate_bytes', 'Estimated download rate per client from queue progress between scrapes, bytes per second.');
    gauge('arclight_download_client_remaining_bytes', 'Bytes left to download per client.');
    gauge('arclight_vpn_enabled', '1 when the VPN integration is enabled.');
    gauge('arclight_vpn_connected', '1 while the VPN is connected.');
    gauge('arclight_subtitles_wanted', 'Wanted (missing) subtitles.');
    gauge('arclight_requests', 'Media requests by status.');
    gauge('arclight_requests_pending', 'Media requests waiting for approval.');

    r.addCollector('process', () => this.collectProcess());
    r.addCollector('queue', () => this.collectQueue());
    r.addCollector('library', () => this.collectLibrary());
    r.addCollector('indexers', () => this.collectIndexers());
    r.addCollector('downloads', () => this.collectDownloads());
    r.addCollector('vpn', () => this.collectVpn());
    r.addCollector('subtitles', () => this.collectSubtitles());
    r.addCollector('requests', () => this.collectRequests());
  }

  /** Subscribe to job/release/import events and start the event-loop monitor. */
  start(): void {
    if (!this.unsubscribe && this.bus) this.unsubscribe = this.bus.subscribe((e) => this.onEvent(e));
    if (!this.loop) {
      this.loop = monitorEventLoopDelay({ resolution: 20 });
      this.loop.enable();
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.loop?.disable();
    this.loop = undefined;
  }

  render(): Promise<string> {
    return this.registry.render((name, err) => this.log?.warn({ err, collector: name }, 'metrics collector failed'));
  }

  // ---- http hook --------------------------------------------------------------------------

  readonly onRequest = async (req: FastifyRequest): Promise<void> => {
    this.started.set(req, process.hrtime.bigint());
  };

  readonly onResponse = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const route = routeLabel(req);
    this.httpRequests.inc({ method: req.method, route, status: reply.statusCode });
    const start = this.started.get(req);
    if (start !== undefined) {
      this.httpDuration.observe({ method: req.method, route }, Number(process.hrtime.bigint() - start) / 1e9);
    }
  };

  // ---- bus events ---------------------------------------------------------------------------

  onEvent(event: ServerEvent): void {
    if (event.type === 'job') {
      const { job } = event;
      if (job.status === 'running') {
        if (!this.runningJobs.has(job.id)) {
          this.runningJobs.set(job.id, job.name);
          this.jobsRunning.inc({ job: job.name });
        }
        return;
      }
      if (job.status === 'queued') return;
      if (this.runningJobs.delete(job.id)) this.jobsRunning.dec({ job: job.name });
      this.jobRuns.inc({ job: job.name, status: job.status });
      if (job.status === 'failed') this.jobFailures.inc({ job: job.name });
      if (job.durationMs !== null && job.durationMs !== undefined) this.jobDuration.observe({ job: job.name }, job.durationMs / 1000);
    } else if (event.type === 'release' && event.action === 'grabbed') {
      this.releasesGrabbed.inc();
    } else if (event.type === 'import') {
      this.imports.inc({ result: event.action });
    }
  }

  // ---- collectors ---------------------------------------------------------------------------

  private collectProcess(): void {
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    this.cpu.user.setTotal({}, cpu.user / 1e6);
    this.cpu.system.setTotal({}, cpu.system / 1e6);
    this.cpu.total.setTotal({}, (cpu.user + cpu.system) / 1e6);
    this.g['process_resident_memory_bytes']!.set(mem.rss);
    this.g['nodejs_heap_size_total_bytes']!.set(mem.heapTotal);
    this.g['nodejs_heap_size_used_bytes']!.set(mem.heapUsed);
    this.g['nodejs_external_memory_bytes']!.set(mem.external);
    const uptime = process.uptime();
    this.g['process_uptime_seconds']!.set(uptime);
    this.g['process_start_time_seconds']!.set(Math.round(Date.now() / 1000 - uptime));
    if (this.loop) {
      const p99 = this.loop.percentile(99);
      this.g['nodejs_eventloop_lag_p99_seconds']!.set(Number.isFinite(p99) ? p99 / 1e9 : 0);
      this.loop.reset();
    }
  }

  private collectQueue(): void {
    const g = this.g['arclight_queue_items']!;
    g.reset();
    const rows = this.db.select({ state: trackedDownloads.state, n: count() }).from(trackedDownloads).groupBy(trackedDownloads.state).all();
    for (const r of rows) g.set({ state: r.state }, r.n);
  }

  private collectLibrary(): void {
    this.g['arclight_library_series']!.set(this.db.select({ n: count() }).from(series).get()?.n ?? 0);
    const movieRows = this.db.select({ hasFile: movies.hasFile, n: count() }).from(movies).groupBy(movies.hasFile).all();
    const m = this.g['arclight_library_movies']!;
    m.reset();
    m.set({ has_file: 'true' }, 0);
    m.set({ has_file: 'false' }, 0);
    for (const r of movieRows) m.set({ has_file: String(r.hasFile) }, r.n);
    const ep = this.g['arclight_library_episodes']!;
    ep.reset();
    const epRows = this.db
      .select({ monitored: episodes.monitored, hasFile: episodes.hasFile, n: count() })
      .from(episodes)
      .groupBy(episodes.monitored, episodes.hasFile)
      .all();
    for (const r of epRows) ep.set({ monitored: String(r.monitored), has_file: String(r.hasFile) }, r.n);
    const files = this.db.select({ n: count(), size: sum(mediaFiles.sizeBytes) }).from(mediaFiles).get();
    this.g['arclight_library_files']!.set(files?.n ?? 0);
    this.g['arclight_library_size_bytes']!.set(Number(files?.size ?? 0));
  }

  private collectIndexers(): void {
    const since = new Date(this.now() - 24 * HOUR_MS).toISOString();
    const names = new Map(this.db.select({ id: indexers.id, name: indexers.name }).from(indexers).all().map((r) => [r.id, r.name]));
    const kinds = { query: 'arclight_indexer_queries_24h', rss: 'arclight_indexer_rss_24h', grab: 'arclight_indexer_grabs_24h' } as const;
    for (const metric of [...Object.values(kinds), 'arclight_indexer_failures_24h', 'arclight_indexer_response_seconds_avg_24h']) {
      this.g[metric]!.reset();
    }
    const rows = this.db
      .select({
        indexerId: indexerStats.indexerId,
        kind: indexerStats.kind,
        success: indexerStats.success,
        n: count(),
        totalMs: sum(indexerStats.durationMs),
      })
      .from(indexerStats)
      .where(gte(indexerStats.at, since))
      .groupBy(indexerStats.indexerId, indexerStats.kind, indexerStats.success)
      .all();
    const timing = new Map<string, { n: number; ms: number }>();
    for (const r of rows) {
      const indexer = names.get(r.indexerId) ?? `#${r.indexerId}`;
      const result = r.success ? 'success' : 'failure';
      const metric = kinds[r.kind as keyof typeof kinds];
      if (metric) this.g[metric]!.inc({ indexer, result }, r.n);
      if (!r.success) this.g['arclight_indexer_failures_24h']!.inc({ indexer }, r.n);
      if (r.kind !== 'grab') {
        const t = timing.get(indexer) ?? { n: 0, ms: 0 };
        t.n += r.n;
        t.ms += Number(r.totalMs ?? 0);
        timing.set(indexer, t);
      }
    }
    for (const [indexer, t] of timing) if (t.n > 0) this.g['arclight_indexer_response_seconds_avg_24h']!.set({ indexer }, t.ms / t.n / 1000);
    const disabled = this.g['arclight_indexer_disabled']!;
    disabled.reset();
    const nowIso = new Date(this.now()).toISOString();
    const statuses = new Map(this.db.select().from(indexerStatus).all().map((s) => [s.indexerId, s]));
    for (const [id, name] of names) {
      const until = statuses.get(id)?.disabledTill;
      disabled.set({ indexer: name }, until && until > nowIso ? 1 : 0);
    }
  }

  private collectDownloads(): void {
    const t = this.sources.torrent?.() ?? null;
    this.g['arclight_torrent_engine_up']!.set(t && t.state === 'running' ? 1 : 0);
    this.g['arclight_torrent_download_rate_bytes']!.set(t?.downloadRate ?? 0);
    this.g['arclight_torrent_upload_rate_bytes']!.set(t?.uploadRate ?? 0);
    this.g['arclight_torrent_peers']!.set(t?.peers ?? 0);

    const clients = this.db.select({ id: downloadClients.id, name: downloadClients.name, enable: downloadClients.enable }).from(downloadClients).all();
    const statuses = this.sources.clientStatuses?.() ?? new Map<number, { ok: boolean }>();
    const up = this.g['arclight_download_client_up']!;
    const rate = this.g['arclight_download_client_rate_bytes']!;
    const remaining = this.g['arclight_download_client_remaining_bytes']!;
    up.reset();
    rate.reset();
    remaining.reset();
    const totals = this.db
      .select({
        clientId: trackedDownloads.clientId,
        done: sql<number>`coalesce(sum(${trackedDownloads.size} - ${trackedDownloads.sizeLeft}), 0)`,
        left: sql<number>`coalesce(sum(${trackedDownloads.sizeLeft}), 0)`,
      })
      .from(trackedDownloads)
      .groupBy(trackedDownloads.clientId)
      .all();
    const byClient = new Map(totals.filter((r) => r.clientId !== null).map((r) => [r.clientId!, r]));
    const at = this.now();
    const previous = this.clientBytes;
    const bytes = new Map<number, number>();
    for (const c of clients) {
      const status = statuses.get(c.id);
      up.set({ client: c.name }, status ? (status.ok ? 1 : 0) : 0);
      const done = Number(byClient.get(c.id)?.done ?? 0);
      bytes.set(c.id, done);
      remaining.set({ client: c.name }, Number(byClient.get(c.id)?.left ?? 0));
      const before = previous?.bytes.get(c.id);
      const seconds = previous ? (at - previous.at) / 1000 : 0;
      // Items leaving the queue make the total drop: that is not negative speed.
      rate.set({ client: c.name }, before !== undefined && seconds > 0 ? Math.max(0, done - before) / seconds : 0);
    }
    this.clientBytes = { at, bytes };
  }

  private collectVpn(): void {
    const v = this.sources.vpn?.() ?? null;
    this.g['arclight_vpn_enabled']!.set(v?.enabled ? 1 : 0);
    this.g['arclight_vpn_connected']!.set(v?.connected ? 1 : 0);
  }

  private collectSubtitles(): void {
    if (!this.sources.subtitlesWanted) return;
    const at = this.now();
    if (!this.wantedCache || at - this.wantedCache.at >= this.slowTtlMs) {
      this.wantedCache = { at, value: this.sources.subtitlesWanted() };
    }
    if (this.wantedCache.value !== null) this.g['arclight_subtitles_wanted']!.set(this.wantedCache.value);
  }

  private collectRequests(): void {
    const g = this.g['arclight_requests']!;
    g.reset();
    const rows = this.db.select({ status: mediaRequests.status, n: count() }).from(mediaRequests).groupBy(mediaRequests.status).all();
    for (const r of rows) g.set({ status: r.status }, r.n);
    const pending = this.db.select({ n: count() }).from(mediaRequests).where(and(eq(mediaRequests.status, 'pending'))).get();
    this.g['arclight_requests_pending']!.set(pending?.n ?? 0);
  }
}
