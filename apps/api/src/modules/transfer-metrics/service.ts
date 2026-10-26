import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  METRICS_RANGE_MS,
  METRICS_RANGE_STEP_MS,
  type DownloadEvent,
  type DownloadMetrics,
  type EngineMetrics,
  type MetricAnnotation,
  type MetricsRange,
  type QueueItemLive,
  type QueueSeverity,
  type ServerEvent,
  type VpnMetricEventType,
  type VpnMetrics,
  type VpnStatus,
} from '@arclight/shared';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from '../../db/index.js';
import { trackedDownloads, transferDownloadPoints, transferEnginePoints, vpnMetricEvents, vpnMetricPoints } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { DownloadTimelineStore } from '../download-clients/index.js';
import { bucketize, DAY_MS, floorTo, HOUR_MS, isoFloor, MINUTE_MS, weightedMean, type FieldMode } from './aggregate.js';
import type { TransferDownloadPointRow, TransferEnginePointRow, VpnMetricEventRow, VpnMetricPointRow } from './schema.js';

// Transfer history. Every `sampleIntervalMs` the sampler reads the live numbers other modules
// already keep (queue items with the engine overlay, engine totals, VPN status) and adds them to
// in-memory per-minute sums; when the minute turns, the finished minute is written in one
// transaction. Hourly roll-ups and pruning are scheduled jobs (jobs.ts). VPN transitions are
// recorded as they are seen, from samples and from `vpn` bus events in between.

/** Live numbers of one tracked download as the queue sees them. */
export interface DownloadSample {
  id: number;
  downloadId: string;
  progress: number;
  live?: Pick<QueueItemLive, 'downloadRate' | 'uploadRate' | 'connectedPeers' | 'connectedSeeds'> | undefined;
}

export interface EngineSample {
  downloadRate: number;
  uploadRate: number;
  peers: number;
  activeTorrents: number;
}

/** Owned by other modules; each may throw (logged, that part of the sample is skipped). */
export interface TransferSources {
  /** Tracked downloads currently transferring. */
  downloads(): readonly DownloadSample[];
  /** Built-in engine totals; null while the engine is not running. */
  engine(): EngineSample | null;
  /** VPN status; null (or `enabled: false`) when no VPN is configured. */
  vpn(): VpnStatus | null;
}

export interface TransferMetricsOptions {
  db: Db;
  sources: TransferSources;
  bus?: EventBus | undefined;
  log?: Logger | undefined;
  now?: () => Date;
  /** Default 10 s. */
  sampleIntervalMs?: number;
  /** 1-minute points are kept this long. Default 7. */
  minuteRetentionDays?: number;
  /** Hourly roll-ups and VPN events are kept this long. Default 90. */
  hourlyRetentionDays?: number;
}

export const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;
export const DEFAULT_MINUTE_RETENTION_DAYS = 7;
export const DEFAULT_HOURLY_RETENTION_DAYS = 90;
/** Annotations per response (most recent kept). */
export const MAX_ANNOTATIONS = 200;

export class TransferMetricsError extends Error {
  constructor(
    readonly code: 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'TransferMetricsError';
  }
}

interface DownloadAcc {
  infoHash: string;
  n: number;
  down: number;
  up: number;
  peers: number;
  seeds: number;
  progress: number;
}
interface EngineAcc {
  n: number;
  down: number;
  up: number;
  peers: number;
  active: number;
}
interface VpnAcc {
  n: number;
  connected: number;
  killSwitch: number;
  warning: number;
  port: number | null;
}
interface VpnState {
  connected: boolean;
  killSwitch: boolean;
  warning: string | null;
  port: number | null;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DownloadPoint = Omit<TransferDownloadPointRow, 'id' | 'resolution'>;
type EnginePoint = Omit<TransferEnginePointRow, 'id' | 'resolution'>;
type VpnPoint = Omit<VpnMetricPointRow, 'id' | 'resolution'>;

const DOWNLOAD_MODES: Partial<Record<keyof DownloadPoint, FieldMode>> = {
  downloadRate: 'avg',
  uploadRate: 'avg',
  peers: 'avg',
  seeds: 'avg',
  progress: 'max',
  infoHash: 'last',
};
const ENGINE_MODES: Partial<Record<keyof EnginePoint, FieldMode>> = { downloadRate: 'avg', uploadRate: 'avg', peers: 'avg', activeTorrents: 'avg' };
const VPN_MODES: Partial<Record<keyof VpnPoint, FieldMode>> = { connected: 'avg', killSwitch: 'avg', warning: 'avg', forwardedPort: 'last' };

const VPN_SEVERITY: Readonly<Record<VpnMetricEventType, QueueSeverity>> = {
  disconnected: 'error',
  connected: 'ok',
  killSwitchEngaged: 'error',
  killSwitchReleased: 'ok',
  portChanged: 'info',
  warning: 'warning',
  warningCleared: 'ok',
};
/** VPN transitions worth marking on the download and engine charts. */
const VPN_ON_TRANSFER: ReadonlySet<VpnMetricEventType> = new Set(['disconnected', 'connected', 'killSwitchEngaged', 'killSwitchReleased']);

export class TransferMetricsService {
  private readonly db: Db;
  private readonly sources: TransferSources;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly timeline: DownloadTimelineStore;
  readonly sampleIntervalMs: number;
  readonly minuteRetentionDays: number;
  readonly hourlyRetentionDays: number;

  /** Start (ms) of the minute being accumulated, null before the first sample. */
  private minute: number | null = null;
  private downloads = new Map<number, DownloadAcc>();
  private engine: EngineAcc | null = null;
  private vpn: VpnAcc | null = null;
  private lastVpn: VpnState | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(opts: TransferMetricsOptions) {
    this.db = opts.db;
    this.sources = opts.sources;
    this.bus = opts.bus;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.timeline = new DownloadTimelineStore(opts.db, this.now);
    this.sampleIntervalMs = opts.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.minuteRetentionDays = opts.minuteRetentionDays ?? DEFAULT_MINUTE_RETENTION_DAYS;
    this.hourlyRetentionDays = opts.hourlyRetentionDays ?? DEFAULT_HOURLY_RETENTION_DAYS;
  }

  start(): void {
    if (this.bus && !this.unsubscribe) this.unsubscribe = this.bus.subscribe((e) => this.onEvent(e));
    if (!this.timer) {
      this.timer = setInterval(() => this.sample(), this.sampleIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
  }

  private onEvent(e: ServerEvent): void {
    if (e.type !== 'vpn') return;
    try {
      this.observeVpn(e.status);
    } catch (err) {
      this.log?.warn({ err }, 'could not record a VPN transition');
    }
  }

  // ---- sampling ------------------------------------------------------------------------------

  /** Takes one sample of everything; writes the previous minute when a new one starts. */
  sample(): void {
    const nowMs = this.now().getTime();
    const minute = floorTo(nowMs, MINUTE_MS);
    if (this.minute !== null && this.minute !== minute) this.flush();
    this.minute = minute;

    this.part('downloads', () => {
      for (const d of this.sources.downloads()) {
        if (d.downloadId.startsWith('pending:')) continue;
        const acc = this.downloads.get(d.id) ?? { infoHash: d.downloadId, n: 0, down: 0, up: 0, peers: 0, seeds: 0, progress: 0 };
        acc.n++;
        acc.down += d.live?.downloadRate ?? 0;
        acc.up += d.live?.uploadRate ?? 0;
        acc.peers += d.live?.connectedPeers ?? 0;
        acc.seeds += d.live?.connectedSeeds ?? 0;
        acc.progress = Math.max(acc.progress, d.progress);
        acc.infoHash = d.downloadId;
        this.downloads.set(d.id, acc);
      }
    });
    this.part('engine', () => {
      const e = this.sources.engine();
      if (!e) return;
      const acc = this.engine ?? { n: 0, down: 0, up: 0, peers: 0, active: 0 };
      acc.n++;
      acc.down += e.downloadRate;
      acc.up += e.uploadRate;
      acc.peers += e.peers;
      acc.active += e.activeTorrents;
      this.engine = acc;
    });
    this.part('vpn', () => {
      const s = this.sources.vpn();
      this.observeVpn(s);
      if (!s?.enabled) return;
      const acc = this.vpn ?? { n: 0, connected: 0, killSwitch: 0, warning: 0, port: null };
      acc.n++;
      if (s.connected) acc.connected++;
      if (s.killSwitchEngaged) acc.killSwitch++;
      if (s.warning) acc.warning++;
      acc.port = s.forwardedPort ?? null;
      this.vpn = acc;
    });
  }

  private part(name: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log?.warn({ err, part: name }, 'transfer metrics sample failed');
    }
  }

  /** Writes the accumulated minute (one transaction, batch inserts) and clears it. */
  flush(): void {
    if (this.minute === null) return;
    const time = new Date(this.minute).toISOString();
    const downloads = [...this.downloads].map(([id, a]) => ({
      trackedDownloadId: id,
      infoHash: a.infoHash,
      resolution: '1m' as const,
      time,
      samples: a.n,
      downloadRate: a.down / a.n,
      uploadRate: a.up / a.n,
      peers: a.peers / a.n,
      seeds: a.seeds / a.n,
      progress: a.progress,
    }));
    const engine = this.engine;
    const vpn = this.vpn;
    this.downloads = new Map();
    this.engine = null;
    this.vpn = null;
    if (downloads.length === 0 && !engine && !vpn) return;
    try {
      this.db.transaction((tx) => {
        if (downloads.length > 0) {
          const t = transferDownloadPoints;
          tx.insert(t)
            .values(downloads)
            .onConflictDoUpdate({
              target: [t.trackedDownloadId, t.resolution, t.time],
              set: {
                infoHash: sql`excluded.info_hash`,
                downloadRate: merged(t.downloadRate, t.samples, 'download_rate'),
                uploadRate: merged(t.uploadRate, t.samples, 'upload_rate'),
                peers: merged(t.peers, t.samples, 'peers'),
                seeds: merged(t.seeds, t.samples, 'seeds'),
                progress: sql`max(${t.progress}, excluded.progress)`,
                samples: sql`${t.samples} + excluded.samples`,
              },
            })
            .run();
        }
        if (engine) {
          const t = transferEnginePoints;
          tx.insert(t)
            .values({
              resolution: '1m',
              time,
              samples: engine.n,
              downloadRate: engine.down / engine.n,
              uploadRate: engine.up / engine.n,
              peers: engine.peers / engine.n,
              activeTorrents: engine.active / engine.n,
            })
            .onConflictDoUpdate({
              target: [t.resolution, t.time],
              set: {
                downloadRate: merged(t.downloadRate, t.samples, 'download_rate'),
                uploadRate: merged(t.uploadRate, t.samples, 'upload_rate'),
                peers: merged(t.peers, t.samples, 'peers'),
                activeTorrents: merged(t.activeTorrents, t.samples, 'active_torrents'),
                samples: sql`${t.samples} + excluded.samples`,
              },
            })
            .run();
        }
        if (vpn) {
          const t = vpnMetricPoints;
          tx.insert(t)
            .values({
              resolution: '1m',
              time,
              samples: vpn.n,
              connected: vpn.connected / vpn.n,
              killSwitch: vpn.killSwitch / vpn.n,
              warning: vpn.warning / vpn.n,
              forwardedPort: vpn.port,
            })
            .onConflictDoUpdate({
              target: [t.resolution, t.time],
              set: {
                connected: merged(t.connected, t.samples, 'connected'),
                killSwitch: merged(t.killSwitch, t.samples, 'kill_switch'),
                warning: merged(t.warning, t.samples, 'warning'),
                forwardedPort: sql`excluded.forwarded_port`,
                samples: sql`${t.samples} + excluded.samples`,
              },
            })
            .run();
        }
      });
    } catch (err) {
      this.log?.warn({ err }, 'could not write transfer metrics');
    }
  }

  /** Records VPN transitions against the last observation (the first one only sets a baseline). */
  observeVpn(status: VpnStatus | null): void {
    if (!status?.enabled) {
      this.lastVpn = null;
      return;
    }
    const next: VpnState = {
      connected: status.connected,
      killSwitch: status.killSwitchEngaged ?? false,
      warning: status.warning ?? null,
      port: status.forwardedPort ?? null,
    };
    const prev = this.lastVpn;
    this.lastVpn = next;
    if (!prev) return;
    const time = this.now().toISOString();
    const rows: (typeof vpnMetricEvents.$inferInsert)[] = [];
    const add = (type: VpnMetricEventType, message?: string, port?: number | null) =>
      rows.push({ time, type, message: message ?? null, port: port ?? null });
    if (prev.connected !== next.connected) add(next.connected ? 'connected' : 'disconnected', next.connected ? undefined : status.error);
    if (prev.killSwitch !== next.killSwitch) add(next.killSwitch ? 'killSwitchEngaged' : 'killSwitchReleased');
    if (prev.port !== next.port) add('portChanged', undefined, next.port);
    if (prev.warning === null && next.warning !== null) add('warning', next.warning);
    else if (prev.warning !== null && next.warning === null) add('warningCleared');
    if (rows.length > 0) this.db.insert(vpnMetricEvents).values(rows).run();
  }

  // ---- roll-up and retention -----------------------------------------------------------------

  /**
   * Folds every finished hour not rolled up yet into '1h' rows (idempotent: rows are replaced).
   * Returns the number of hourly rows written.
   */
  rollup(): number {
    const end = floorTo(this.now().getTime(), HOUR_MS);
    let written = 0;
    this.db.transaction((tx) => {
      // Downloads: per tracked download.
      {
        const t = transferDownloadPoints;
        const start = this.rollupStart(tx, t, t.resolution, t.time);
        if (start !== null && start < end) {
          const rows = tx
            .select()
            .from(t)
            .where(and(eq(t.resolution, '1m'), gte(t.time, iso(start)), lt(t.time, iso(end))))
            .orderBy(asc(t.trackedDownloadId), asc(t.time))
            .all();
          const byId = groupBy(rows, (r) => r.trackedDownloadId);
          for (const group of byId.values()) {
            const hours = bucketize(group.map(stripRow), HOUR_MS, DOWNLOAD_MODES);
            for (const h of hours) {
              tx.insert(t)
                .values({ ...h, resolution: '1h' })
                .onConflictDoUpdate({ target: [t.trackedDownloadId, t.resolution, t.time], set: { ...h } })
                .run();
              written++;
            }
          }
        }
      }
      {
        const t = transferEnginePoints;
        const start = this.rollupStart(tx, t, t.resolution, t.time);
        if (start !== null && start < end) {
          const rows = tx
            .select()
            .from(t)
            .where(and(eq(t.resolution, '1m'), gte(t.time, iso(start)), lt(t.time, iso(end))))
            .orderBy(asc(t.time))
            .all();
          for (const h of bucketize(rows.map(stripRow), HOUR_MS, ENGINE_MODES)) {
            tx.insert(t).values({ ...h, resolution: '1h' }).onConflictDoUpdate({ target: [t.resolution, t.time], set: { ...h } }).run();
            written++;
          }
        }
      }
      {
        const t = vpnMetricPoints;
        const start = this.rollupStart(tx, t, t.resolution, t.time);
        if (start !== null && start < end) {
          const rows = tx
            .select()
            .from(t)
            .where(and(eq(t.resolution, '1m'), gte(t.time, iso(start)), lt(t.time, iso(end))))
            .orderBy(asc(t.time))
            .all();
          for (const h of bucketize(rows.map(stripRow), HOUR_MS, VPN_MODES)) {
            tx.insert(t).values({ ...h, resolution: '1h' }).onConflictDoUpdate({ target: [t.resolution, t.time], set: { ...h } }).run();
            written++;
          }
        }
      }
    });
    return written;
  }

  /** First hour to roll up: after the newest '1h' row, else the hour of the oldest '1m' row. */
  private rollupStart(tx: Tx, table: SQLiteTable, resolution: AnySQLiteColumn, time: AnySQLiteColumn): number | null {
    const last = tx.select({ t: sql<string | null>`max(${time})` }).from(table).where(eq(resolution, '1h')).get()?.t;
    if (last) return Date.parse(last) + HOUR_MS;
    const first = tx.select({ t: sql<string | null>`min(${time})` }).from(table).where(eq(resolution, '1m')).get()?.t;
    return first ? floorTo(Date.parse(first), HOUR_MS) : null;
  }

  /** Drops 1-minute points past their retention, hourly points and VPN events past theirs. */
  prune(): { minutes: number; hours: number; events: number } {
    const now = this.now().getTime();
    const minuteCutoff = iso(now - this.minuteRetentionDays * DAY_MS);
    const hourCutoff = iso(now - this.hourlyRetentionDays * DAY_MS);
    let minutes = 0;
    let hours = 0;
    for (const t of [transferDownloadPoints, transferEnginePoints, vpnMetricPoints]) {
      minutes += this.db.delete(t).where(and(eq(t.resolution, '1m'), lt(t.time, minuteCutoff))).run().changes;
      hours += this.db.delete(t).where(and(eq(t.resolution, '1h'), lt(t.time, hourCutoff))).run().changes;
    }
    const events = this.db.delete(vpnMetricEvents).where(lt(vpnMetricEvents.time, hourCutoff)).run().changes;
    return { minutes, hours, events };
  }

  // ---- queries -------------------------------------------------------------------------------

  downloadMetrics(trackedDownloadId: number, range: MetricsRange): DownloadMetrics {
    const w = this.window(range);
    const t = transferDownloadPoints;
    const forId = eq(t.trackedDownloadId, trackedDownloadId);
    const raw = this.readPoints<DownloadPoint>(t, w, forId);
    const pending = this.downloads.get(trackedDownloadId);
    if (pending && this.minute !== null && this.minute >= w.fromMs) {
      raw.push({
        trackedDownloadId,
        infoHash: pending.infoHash,
        time: iso(this.minute),
        samples: pending.n,
        downloadRate: pending.down / pending.n,
        uploadRate: pending.up / pending.n,
        peers: pending.peers / pending.n,
        seeds: pending.seeds / pending.n,
        progress: pending.progress,
      });
    }
    if (raw.length === 0) {
      const tracked = this.db.select({ id: trackedDownloads.id }).from(trackedDownloads).where(eq(trackedDownloads.id, trackedDownloadId)).get();
      if (!tracked && !this.timeline.has(trackedDownloadId)) {
        throw new TransferMetricsError('NOT_FOUND', `Queue item ${trackedDownloadId} not found`);
      }
    }
    const points = bucketize(raw, w.stepMs, DOWNLOAD_MODES).map((p) => ({
      time: p.time,
      downloadRate: p.downloadRate,
      uploadRate: p.uploadRate,
      peers: p.peers,
      seeds: p.seeds,
      progress: p.progress,
    }));
    const events = this.timeline.list(trackedDownloadId).events.filter((e) => e.time >= w.from);
    const annotations = [...events.map(downloadAnnotation), ...this.vpnAnnotations(w.from, VPN_ON_TRANSFER)];
    return { trackedDownloadId, ...this.envelope(range, w), points, annotations: capAnnotations(annotations) };
  }

  engineMetrics(range: MetricsRange): EngineMetrics {
    const w = this.window(range);
    const raw = this.readPoints<EnginePoint>(transferEnginePoints, w);
    const e = this.engine;
    if (e && this.minute !== null && this.minute >= w.fromMs) {
      raw.push({ time: iso(this.minute), samples: e.n, downloadRate: e.down / e.n, uploadRate: e.up / e.n, peers: e.peers / e.n, activeTorrents: e.active / e.n });
    }
    const points = bucketize(raw, w.stepMs, ENGINE_MODES).map((p) => ({
      time: p.time,
      downloadRate: p.downloadRate,
      uploadRate: p.uploadRate,
      peers: p.peers,
      activeTorrents: p.activeTorrents,
    }));
    const downloadEvents = this.timeline.since(w.from).filter(onEngineChart).map(downloadAnnotation);
    const annotations = [...downloadEvents, ...this.vpnAnnotations(w.from, VPN_ON_TRANSFER)];
    return { ...this.envelope(range, w), points, annotations: capAnnotations(annotations) };
  }

  vpnMetrics(range: MetricsRange): VpnMetrics {
    const w = this.window(range);
    const raw = this.readPoints<VpnPoint>(vpnMetricPoints, w);
    const v = this.vpn;
    if (v && this.minute !== null && this.minute >= w.fromMs) {
      raw.push({ time: iso(this.minute), samples: v.n, connected: v.connected / v.n, killSwitch: v.killSwitch / v.n, warning: v.warning / v.n, forwardedPort: v.port });
    }
    const points = bucketize(raw, w.stepMs, VPN_MODES).map((p) => ({
      time: p.time,
      connected: p.connected,
      killSwitch: p.killSwitch,
      warning: p.warning,
      forwardedPort: p.forwardedPort,
    }));
    return {
      ...this.envelope(range, w),
      points,
      annotations: capAnnotations(this.vpnAnnotations(w.from)),
      uptime: weightedMean(raw, 'connected'),
    };
  }

  private window(range: MetricsRange): { range: MetricsRange; fromMs: number; from: string; to: string; stepMs: number } {
    const nowMs = this.now().getTime();
    const stepMs = METRICS_RANGE_STEP_MS[range];
    const fromMs = floorTo(nowMs - METRICS_RANGE_MS[range], stepMs);
    return { range, fromMs, from: iso(fromMs), to: iso(nowMs), stepMs };
  }

  private envelope(range: MetricsRange, w: { from: string; to: string; stepMs: number }) {
    return { range, from: w.from, to: w.to, stepMs: w.stepMs };
  }

  /**
   * Stored points of a window, oldest first, without id/resolution. Up to a day reads the
   * 1-minute points; longer windows read hourly roll-ups plus the minutes after the last one.
   */
  private readPoints<P extends { time: string; samples: number }>(
    // Any of the three point tables; callers pick P to match.
    table: typeof transferEnginePoints | typeof vpnMetricPoints | typeof transferDownloadPoints,
    w: { fromMs: number; from: string; stepMs: number },
    extra?: ReturnType<typeof eq>,
  ): P[] {
    const cols = table as typeof transferEnginePoints;
    const where = (resolution: '1m' | '1h', since: string) =>
      extra ? and(eq(cols.resolution, resolution), gte(cols.time, since), extra) : and(eq(cols.resolution, resolution), gte(cols.time, since));
    const read = (resolution: '1m' | '1h', since: string) =>
      // Cast: every point table has resolution/time/samples; P names the rest for the caller.
      (this.db.select().from(cols).where(where(resolution, since)).orderBy(asc(cols.time)).all() as unknown as P[]).map(stripRow) as P[];
    if (w.stepMs < HOUR_MS) return read('1m', w.from);
    const hours = read('1h', isoFloor(w.fromMs, HOUR_MS));
    const last = hours[hours.length - 1];
    const minutesFrom = last ? iso(Date.parse(last.time) + HOUR_MS) : w.from;
    return [...hours, ...read('1m', minutesFrom)];
  }

  private vpnAnnotations(fromIso: string, only?: ReadonlySet<VpnMetricEventType>): MetricAnnotation[] {
    return this.db
      .select()
      .from(vpnMetricEvents)
      .where(gte(vpnMetricEvents.time, fromIso))
      .orderBy(asc(vpnMetricEvents.time), asc(vpnMetricEvents.id))
      .all()
      .filter((r) => !only || only.has(r.type))
      .map(vpnAnnotation);
  }
}

/** Sample-weighted merge of an existing row with the incoming one (`excluded`). */
function merged(column: Parameters<typeof sql>[1], samples: Parameters<typeof sql>[1], name: string) {
  return sql`(${column} * ${samples} + ${sql.raw(`excluded.${name}`)} * excluded.samples) / (${samples} + excluded.samples)`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function stripRow<T extends object>(row: T): Omit<T, 'id' | 'resolution'> {
  const { id: _id, resolution: _resolution, ...rest } = row as T & { id?: unknown; resolution?: unknown };
  return rest;
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** Download timeline entries that explain an engine-wide dip: stalls, errors, kill-switch pauses. */
function onEngineChart(e: DownloadEvent): boolean {
  if (e.type === 'stalled' || e.type === 'recovered' || e.type === 'error') return true;
  return (e.type === 'paused' || e.type === 'resumed') && e.data?.reason === 'killSwitch';
}

function downloadAnnotation(e: DownloadEvent): MetricAnnotation {
  const reason = e.data?.reason;
  return {
    time: e.time,
    source: 'download',
    type: e.type,
    severity: e.severity,
    trackedDownloadId: e.trackedDownloadId,
    title: e.title,
    ...(e.message !== undefined ? { message: e.message } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

function vpnAnnotation(r: VpnMetricEventRow): MetricAnnotation {
  return {
    time: r.time,
    source: 'vpn',
    type: r.type,
    severity: VPN_SEVERITY[r.type],
    ...(r.message !== null ? { message: r.message } : {}),
    ...(r.port !== null ? { port: r.port } : {}),
  };
}

function capAnnotations(list: MetricAnnotation[]): MetricAnnotation[] {
  const sorted = list.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return sorted.length > MAX_ANNOTATIONS ? sorted.slice(sorted.length - MAX_ANNOTATIONS) : sorted;
}
