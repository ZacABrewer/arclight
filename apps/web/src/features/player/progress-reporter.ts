import type { ProgressBeacon, ProgressReport } from '@arclight/shared';

// Progress reporting (plan 5.3): `start` when an item begins, a `progress` heartbeat every 15 s
// while it plays, `pause` / `seek` when they happen, `stop` when it is left, and a sendBeacon
// copy on pagehide / tab hidden so closing the tab still saves the place. Every report carries
// the device time; the server ignores reports older than what it has.

export const HEARTBEAT_MS = 15_000;

export interface ReporterSnapshot {
  itemKey: string;
  positionMs: number;
  durationMs: number;
  speed: number;
  playing: boolean;
  playMethod: 'DirectPlay' | 'Transcode';
}

export interface ReporterOptions {
  /** What is playing right now; null: nothing. */
  read: () => ReporterSnapshot | null;
  send: (itemKey: string, report: ProgressReport) => Promise<unknown>;
  beacon: (body: ProgressBeacon) => boolean;
  deviceId: string;
  deviceName?: string;
  now?: () => Date;
  heartbeatMs?: number;
}

type Event = ProgressReport['event'];

export class ProgressReporter {
  private readonly opts: ReporterOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: { itemKey: string; positionMs: number; event: Event } | null = null;
  private started: string | null = null;

  constructor(opts: ReporterOptions) {
    this.opts = opts;
  }

  private build(s: ReporterSnapshot, event: Event): ProgressReport {
    const speed = Math.min(3.5, Math.max(0.5, s.speed));
    return {
      event,
      positionMs: Math.max(0, Math.floor(s.positionMs)),
      durationMs: Math.max(0, Math.floor(s.durationMs)),
      speed,
      deviceId: this.opts.deviceId,
      ...(this.opts.deviceName ? { deviceName: this.opts.deviceName } : {}),
      clientTime: (this.opts.now?.() ?? new Date()).toISOString(),
      playMethod: s.playMethod,
    };
  }

  /** Send one report now (failures are dropped: the next heartbeat carries the place). */
  report(event: Event, override?: Partial<ReporterSnapshot>): void {
    const base = this.opts.read();
    if (!base && !override?.itemKey) return;
    const s = { ...(base as ReporterSnapshot), ...override } as ReporterSnapshot;
    if (!s.itemKey) return;
    if (event === 'start') this.started = s.itemKey;
    const body = this.build(s, event);
    this.last = { itemKey: s.itemKey, positionMs: body.positionMs, event };
    void this.opts.send(s.itemKey, body).catch(() => undefined);
  }

  /** The item that got a `start` (and still needs a `stop`). */
  get startedKey(): string | null {
    return this.started;
  }

  /** `stop` for the item that is being left (before another one loads). */
  stop(snapshot?: ReporterSnapshot | null): void {
    const s = snapshot ?? this.opts.read();
    this.stopHeartbeat();
    if (s && this.started === s.itemKey) this.report('stop', s);
    this.started = null;
  }

  /** Send the place now and wait for the server (before a profile switch takes the session over). */
  async flush(): Promise<void> {
    const s = this.opts.read();
    if (!s || this.started !== s.itemKey) return;
    const event: Event = s.playing ? 'progress' : 'pause';
    const body = this.build(s, event);
    this.last = { itemKey: s.itemKey, positionMs: body.positionMs, event };
    await this.opts.send(s.itemKey, body).catch(() => undefined);
  }

  /** Forget the started item without reporting (the profile it belonged to has left). */
  forget(): void {
    this.stopHeartbeat();
    this.started = null;
    this.last = null;
  }

  /** One heartbeat: skipped while paused or when nothing moved since the last report (stale). */
  heartbeat(): void {
    const s = this.opts.read();
    if (!s || !s.playing) return;
    const pos = Math.floor(s.positionMs);
    if (this.last && this.last.itemKey === s.itemKey && this.last.positionMs === pos) return;
    this.report('progress', s);
  }

  startHeartbeat(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs ?? HEARTBEAT_MS);
  }

  stopHeartbeat(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** The page is going away or hidden: send the place with sendBeacon. */
  beacon(event: Event): boolean {
    const s = this.opts.read();
    if (!s) return false;
    const body: ProgressBeacon = { ...this.build(s, event), itemKey: s.itemKey as ProgressBeacon['itemKey'] };
    this.last = { itemKey: s.itemKey, positionMs: body.positionMs, event };
    return this.opts.beacon(body);
  }

  dispose(): void {
    this.stopHeartbeat();
  }
}
