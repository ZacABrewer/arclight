import { randomBytes } from 'node:crypto';
import {
  ACTIVE_STREAM_IDLE_SEC,
  ACTIVE_STREAM_PAUSED_IDLE_SEC,
  type ActiveStreamClientKind,
  type ActiveStreamMethod,
  type MobilePlatform,
  type ProgressReport,
  type TranscodeHwaccel,
  type VideoReason,
} from '@arclight/shared';

// Activity -> Now playing (0.25): an in-memory list of what the player is streaming right now.
// Nothing is stored: a restart starts empty and the next heartbeat brings a stream back.
//
// A stream is one device playing one item for one household profile. Progress heartbeats (PUT
// /playback/progress, the beacon) name the device and carry the position and pause state; the
// video session route names the device too (HLS: `deviceKey`). Stream and segment requests keep a
// stream alive and say how it plays, but signed links do not name the device, so what they learn
// is kept per (user, profile, item) as the item's "delivery" and joined in when listing. A stream
// request nobody heartbeats for (an external player with a copied link) shows as a provisional
// row; the first heartbeat for the same item takes it over.

export const IDLE_MS = ACTIVE_STREAM_IDLE_SEC * 1000;
export const PAUSED_IDLE_MS = ACTIVE_STREAM_PAUSED_IDLE_SEC * 1000;
/** Device clocks are trusted this far: an older heartbeat is an offline queue replaying. */
const STALE_REPORT_MS = 2 * 60_000;
const MAX_ENTRIES = 2000;
/** A response that never closed (a stuck socket) stops counting after this. */
const OPEN_MAX_MS = 12 * 60 * 60_000;

/** Who is playing: the account and the household profile (0: the owner profile). */
export interface StreamViewer {
  userId: number;
  /** The profile id, or 0 for the owner profile (links name no profile for the owner). */
  profileKey: number;
}

export interface StreamClient {
  kind: ActiveStreamClientKind;
  deviceName: string | null;
  platform: MobilePlatform | null;
  appVersion: string | null;
}

/** Where a request came from. `client` null: unknown (a signed link), keep what is known. */
export interface StreamOrigin {
  ip: string;
  remote: boolean;
  client: StreamClient | null;
}

export interface StreamDelivery {
  method: ActiveStreamMethod | null;
  delivery: 'progressive' | 'hls' | null;
  backend: 'arclight' | 'jellyfin';
  reasons: VideoReason[];
  hlsSessionId: string | null;
  /** Progressive video conversions: the encoder (HLS asks the live session instead). */
  hwaccel: TranscodeHwaccel | null;
  audioFormat: string | null;
  bitrateKbps: number | null;
}

export interface StreamEntry {
  id: string;
  viewer: StreamViewer;
  /** Null: provisional (seen only through stream requests). */
  deviceId: string | null;
  itemKey: string;
  startedAt: number;
  lastSeen: number;
  /** When the position was reported (extrapolated from here while playing). */
  reportedAt: number;
  positionMs: number;
  durationMs: number;
  speed: number;
  state: 'playing' | 'paused';
  /** A heartbeat has reported the position (a session's start position is only a guess). */
  reported: boolean;
  client: StreamClient;
  ip: string;
  remote: boolean;
}

/** One row of the list: the entry, its delivery and the position now. */
export interface ActiveStreamRow extends StreamEntry {
  delivery: StreamDelivery | null;
  positionNowMs: number;
}

const UNKNOWN_CLIENT: StreamClient = { kind: 'other', deviceName: null, platform: null, appVersion: null };

const emptyDelivery = (): StreamDelivery => ({ method: null, delivery: null, backend: 'arclight', reasons: [], hlsSessionId: null, hwaccel: null, audioFormat: null, bitrateKbps: null });

const itemOf = (v: StreamViewer, itemKey: string) => `${v.userId}:${v.profileKey}:${itemKey}`;
const deviceOf = (v: StreamViewer, deviceId: string) => `${v.userId}:${v.profileKey}:d:${deviceId}`;
const provisionalOf = (v: StreamViewer, itemKey: string) => `${v.userId}:${v.profileKey}:p:${itemKey}`;

export interface ActiveStreamsOptions {
  now?: () => number;
}

export class ActiveStreams {
  private readonly now: () => number;
  /** Device and provisional entries by key (deviceOf / provisionalOf). */
  private readonly entries = new Map<string, StreamEntry>();
  /** What stream requests and sessions said about an item, by itemOf. */
  private readonly deliveries = new Map<string, StreamDelivery & { at: number }>();
  /** HLS session id -> itemOf key of the delivery that names it. */
  private readonly hls = new Map<string, string>();
  /** Responses still being sent, by itemOf (a long progressive stream is alive while it flows). */
  private readonly open = new Map<string, number>();

  constructor(opts: ActiveStreamsOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** A progress report from a player (PUT /playback/progress, the beacon, a fresh batch entry). */
  heartbeat(viewer: StreamViewer, itemKey: string, report: ProgressReport, origin: StreamOrigin): void {
    const at = this.now();
    const sent = Date.parse(report.clientTime);
    if (Number.isFinite(sent) && at - sent > STALE_REPORT_MS) return;
    const key = deviceOf(viewer, report.deviceId);
    if (report.event === 'stop') {
      const e = this.entries.get(key);
      if (e && e.itemKey === itemKey) this.entries.delete(key);
      this.entries.delete(provisionalOf(viewer, itemKey));
      this.sweep(at);
      return;
    }
    const entry = this.deviceEntry(viewer, report.deviceId, itemKey, origin, at);
    entry.positionMs = report.positionMs;
    entry.reported = true;
    if (report.durationMs > 0) entry.durationMs = report.durationMs;
    entry.reportedAt = at;
    entry.speed = report.speed ?? 1;
    // A seek keeps the state it happened in; every other event says it.
    if (report.event === 'pause') entry.state = 'paused';
    else if (report.event !== 'seek') entry.state = 'playing';
    if (report.deviceName && (entry.client.kind === 'web' || !entry.client.deviceName)) entry.client = { ...entry.client, deviceName: report.deviceName };
    if (report.playMethod && !this.deliveries.get(itemOf(viewer, itemKey))?.method) {
      // The player's own idea, until a stream request says more (DirectPlay / Transcode).
      this.deliver(viewer, itemKey, { method: report.playMethod === 'DirectPlay' ? 'direct' : 'transcode' }, at);
    }
    this.sweep(at);
  }

  /** POST /playback/video/session: the device (when it says), the item and how it will play. */
  videoSession(viewer: StreamViewer, input: { deviceKey: string | null; itemKey: string; startMs: number; durationMs: number; delivery: Partial<StreamDelivery> }, origin: StreamOrigin): void {
    const at = this.now();
    const entry = input.deviceKey ? this.deviceEntry(viewer, input.deviceKey, input.itemKey, origin, at) : this.provisional(viewer, input.itemKey, origin, at);
    if (!entry.reported) entry.positionMs = input.startMs;
    if (input.durationMs > 0) entry.durationMs = input.durationMs;
    // A new session replaces what the item played as before (another quality, another file).
    this.deliveries.delete(itemOf(viewer, input.itemKey));
    this.deliver(viewer, input.itemKey, input.delivery, at);
    this.sweep(at);
  }

  /**
   * A stream request (audio or progressive video) for an item; the returned function is called
   * when the response ends. Touches the item's streams, or adds a provisional one.
   */
  streamOpened(viewer: StreamViewer, itemKey: string, delivery: Partial<StreamDelivery>, origin: StreamOrigin): () => void {
    const at = this.now();
    const k = itemOf(viewer, itemKey);
    const live = this.entriesOf(viewer, itemKey);
    if (live.length === 0) this.provisional(viewer, itemKey, origin, at);
    for (const e of live) e.lastSeen = at;
    this.deliver(viewer, itemKey, delivery, at);
    this.open.set(k, (this.open.get(k) ?? 0) + 1);
    let done = false;
    this.sweep(at);
    return () => {
      if (done) return;
      done = true;
      const n = (this.open.get(k) ?? 1) - 1;
      if (n <= 0) this.open.delete(k);
      else this.open.set(k, n);
      const end = this.now();
      for (const e of this.entriesOf(viewer, itemKey)) e.lastSeen = Math.max(e.lastSeen, end);
    };
  }

  /** What a stream request learned after it started (the encoder a live video ended up on). */
  update(viewer: StreamViewer, itemKey: string, delivery: Partial<StreamDelivery>): void {
    this.deliver(viewer, itemKey, delivery, this.now());
  }

  /** An HLS playlist or segment request: the session's streams are alive. */
  hlsTouched(sessionId: string): void {
    const k = this.hls.get(sessionId);
    if (!k) return;
    const at = this.now();
    const d = this.deliveries.get(k);
    if (d) d.at = at;
    for (const e of this.entries.values()) if (itemOf(e.viewer, e.itemKey) === k) e.lastSeen = at;
  }

  /** DELETE /playback/video/session/:id: the player closed or left the item. */
  hlsEnded(sessionId: string): void {
    const k = this.hls.get(sessionId);
    this.hls.delete(sessionId);
    if (!k || this.deliveries.get(k)?.hlsSessionId !== sessionId) return;
    this.deliveries.delete(k);
    for (const [key, e] of this.entries) if (itemOf(e.viewer, e.itemKey) === k) this.entries.delete(key);
    this.open.delete(k);
  }

  /** The live streams, newest first. */
  list(): ActiveStreamRow[] {
    const at = this.now();
    this.sweep(at);
    return [...this.entries.values()]
      .map((e) => {
        const elapsed = e.state === 'playing' ? Math.max(0, at - e.reportedAt) * e.speed : 0;
        let positionNowMs = Math.round(e.positionMs + elapsed);
        if (e.durationMs > 0) positionNowMs = Math.min(positionNowMs, e.durationMs);
        const d = this.deliveries.get(itemOf(e.viewer, e.itemKey));
        return { ...e, client: { ...e.client }, delivery: d ? strip(d) : null, positionNowMs };
      })
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get size(): number {
    return this.entries.size;
  }

  // ---- internals ----------------------------------------------------------------------------

  private entriesOf(viewer: StreamViewer, itemKey: string): StreamEntry[] {
    const k = itemOf(viewer, itemKey);
    return [...this.entries.values()].filter((e) => itemOf(e.viewer, e.itemKey) === k);
  }

  private fresh(viewer: StreamViewer, deviceId: string | null, itemKey: string, origin: StreamOrigin, at: number): StreamEntry {
    return {
      id: randomBytes(9).toString('base64url'),
      viewer: { ...viewer },
      deviceId,
      itemKey,
      startedAt: at,
      lastSeen: at,
      reportedAt: at,
      positionMs: 0,
      durationMs: 0,
      speed: 1,
      state: 'playing',
      reported: false,
      client: origin.client ?? { ...UNKNOWN_CLIENT },
      ip: origin.ip,
      remote: origin.remote,
    };
  }

  /** The device's entry, switched to `itemKey` (a new item restarts it); takes over a provisional one. */
  private deviceEntry(viewer: StreamViewer, deviceId: string, itemKey: string, origin: StreamOrigin, at: number): StreamEntry {
    const key = deviceOf(viewer, deviceId);
    let entry = this.entries.get(key);
    const pending = this.entries.get(provisionalOf(viewer, itemKey));
    if (entry && entry.itemKey !== itemKey) entry = undefined;
    if (!entry) {
      entry = this.fresh(viewer, deviceId, itemKey, origin, at);
      if (pending) {
        entry.id = pending.id;
        entry.startedAt = Math.min(entry.startedAt, pending.startedAt);
        entry.durationMs = pending.durationMs;
        entry.positionMs = pending.positionMs;
      }
      this.entries.set(key, entry);
    }
    if (pending) this.entries.delete(provisionalOf(viewer, itemKey));
    entry.lastSeen = at;
    entry.ip = origin.ip;
    entry.remote = origin.remote;
    if (origin.client) entry.client = { ...origin.client, deviceName: origin.client.deviceName ?? entry.client.deviceName };
    return entry;
  }

  private provisional(viewer: StreamViewer, itemKey: string, origin: StreamOrigin, at: number): StreamEntry {
    const key = provisionalOf(viewer, itemKey);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.fresh(viewer, null, itemKey, origin, at);
      this.entries.set(key, entry);
    }
    entry.lastSeen = at;
    entry.ip = origin.ip;
    entry.remote = origin.remote;
    if (origin.client) entry.client = origin.client;
    return entry;
  }

  private deliver(viewer: StreamViewer, itemKey: string, patch: Partial<StreamDelivery>, at: number): void {
    const k = itemOf(viewer, itemKey);
    const d = this.deliveries.get(k) ?? { ...emptyDelivery(), at };
    for (const [field, value] of Object.entries(patch) as Array<[keyof StreamDelivery, never]>) if (value !== undefined) d[field] = value;
    d.at = at;
    this.deliveries.set(k, d);
    if (d.hlsSessionId) this.hls.set(d.hlsSessionId, k);
  }

  private alive(e: StreamEntry, at: number): boolean {
    // An open response keeps it (a progressive stream flows for minutes per request), within reason.
    if ((this.open.get(itemOf(e.viewer, e.itemKey)) ?? 0) > 0 && at - e.lastSeen < OPEN_MAX_MS) return true;
    return at - e.lastSeen < (e.state === 'paused' ? PAUSED_IDLE_MS : IDLE_MS);
  }

  private sweep(at: number): void {
    for (const [key, e] of this.entries) if (!this.alive(e, at)) this.entries.delete(key);
    const used = new Set([...this.entries.values()].map((e) => itemOf(e.viewer, e.itemKey)));
    for (const [k, d] of this.deliveries) {
      if (used.has(k) || at - d.at < PAUSED_IDLE_MS) continue;
      this.deliveries.delete(k);
      if (d.hlsSessionId) this.hls.delete(d.hlsSessionId);
    }
    for (const [id, k] of this.hls) if (!this.deliveries.has(k)) this.hls.delete(id);
    // A runaway client (a script with a new device id per request) cannot grow this without bound.
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, this.entries.size - MAX_ENTRIES);
      for (const [key] of oldest) this.entries.delete(key);
    }
  }
}

function strip(d: StreamDelivery & { at: number }): StreamDelivery {
  const { at: _at, ...rest } = d;
  return { ...rest, reasons: [...rest.reasons] };
}
