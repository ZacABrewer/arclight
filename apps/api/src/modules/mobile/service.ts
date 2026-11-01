import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { MobileDeviceInput, MobileDeviceResource, MobileTestResult, PushPayload, RelaySendBody } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { mobileDevices } from './schema.js';
import { RelayClient, type RelayOutcome } from './relay.js';

// Mobile companion app devices and delivery through the push relay. The push module calls
// `deliver(userId, payload)` (via the sink it accepts) for every notification it sends to a
// user's browsers, after the user's PushPreferences said yes, so the phone gets exactly what
// the browser gets. Delivery never blocks the caller; failures are handled here:
//   404 / 410      → the device is deleted
//   429 / 5xx / timeout / network → the relay is paused (Retry-After, else 5 s doubling to 5 min)
//                    and the send is retried once when the pause ends; sends that arrive while
//                    paused wait for that same moment (at most MAX_PENDING_RETRIES of them), so
//                    a struggling relay never sees a retry storm.
//   other 4xx      → recorded as the device's last error, not retried

/** Body text longer than this is cut (same limit as web push). */
const MAX_BODY_CHARS = 600;
const MAX_TITLE_CHARS = 200;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Retry-After above this is clamped; a misbehaving relay cannot silence us for a day. */
const MAX_RETRY_AFTER_MS = 15 * 60_000;
const MAX_PENDING_RETRIES = 50;
/** One test notification per device per this long. */
export const TEST_INTERVAL_MS = 10_000;

export type MobileErrorCode = 'NO_USER' | 'NOT_FOUND' | 'FORBIDDEN' | 'RATE_LIMITED';

export class MobileError extends Error {
  constructor(
    readonly code: MobileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MobileError';
  }
}

export interface MobileServiceOptions {
  db: Db;
  log?: Logger;
  /** Relay base URL (ARCLIGHT_PUSH_RELAY_URL). */
  relayUrl: string;
  /** False with ARCLIGHT_PUSH_RELAY=off: devices can still be listed / removed, nothing is sent. */
  enabled: boolean;
  /** The server's public base URL for `data.server` (the Application URL setting), if set. */
  serverUrl?: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Test seams for the backoff timing. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface DeliveryResult {
  sent: number;
  removed: number;
  failed: number;
  /** Waiting for the relay's pause to end (one retry). */
  deferred: number;
}

type DeviceRow = typeof mobileDevices.$inferSelect;

function toResource(row: DeviceRow, userName?: string | null): MobileDeviceResource {
  return {
    id: row.id,
    userId: row.userId,
    relayDeviceId: row.relayDeviceId,
    platform: row.platform,
    deviceName: row.deviceName,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    ...(userName ? { userName } : {}),
    ...(row.appVersion ? { appVersion: row.appVersion } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Trimmed absolute http(s) URL without a trailing slash; undefined for anything else. */
export function normaliseServerUrl(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

export class MobileService {
  private readonly relay: RelayClient;
  private pausedUntil = 0;
  private failures = 0;
  /** Why the relay is paused (the last 429 / 5xx / network message), for the devices that wait. */
  private pauseReason = 'push relay paused after an error';
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly lastTest = new Map<number, number>();
  private disposed = false;

  constructor(private readonly opts: MobileServiceOptions) {
    this.relay = new RelayClient({
      baseUrl: opts.relayUrl,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  serverUrl(): string | undefined {
    return normaliseServerUrl(this.opts.serverUrl?.());
  }

  // ---- devices -----------------------------------------------------------------------

  list(userId: number): MobileDeviceResource[] {
    return this.opts.db.select().from(mobileDevices).where(eq(mobileDevices.userId, userId)).orderBy(mobileDevices.id).all().map((r) => toResource(r));
  }

  /** Every user's devices with the owner's name (admins). */
  listAll(): MobileDeviceResource[] {
    return this.opts.db
      .select({ device: mobileDevices, username: users.username, displayName: users.displayName })
      .from(mobileDevices)
      .innerJoin(users, eq(users.id, mobileDevices.userId))
      .orderBy(mobileDevices.id)
      .all()
      .map((r) => toResource(r.device, r.displayName ?? r.username));
  }

  /** Upsert by relay device id: a phone that re-registers (or signs in as someone else) keeps one row, bound to `userId`. */
  register(userId: number, input: MobileDeviceInput): MobileDeviceResource {
    const now = this.iso();
    const values = {
      userId,
      relayDeviceId: input.relayDeviceId,
      relaySecret: input.relaySecret,
      platform: input.platform,
      deviceName: input.deviceName ?? '',
      appVersion: input.appVersion ?? null,
      createdAt: now,
      lastSeenAt: now,
      lastError: null,
    };
    const row = this.opts.db
      .insert(mobileDevices)
      .values(values)
      .onConflictDoUpdate({
        target: mobileDevices.relayDeviceId,
        set: { userId, relaySecret: values.relaySecret, platform: values.platform, deviceName: values.deviceName, appVersion: values.appVersion, lastSeenAt: now, lastError: null },
      })
      .returning()
      .get();
    this.opts.log?.info({ device: row.id, user: userId, platform: row.platform }, 'mobile device registered');
    return toResource(row);
  }

  /** The device when the caller owns it (or is an admin); NOT_FOUND otherwise (no existence leak). */
  private owned(callerId: number | null, isAdmin: boolean, id: number): DeviceRow {
    const row = this.opts.db.select().from(mobileDevices).where(eq(mobileDevices.id, id)).get();
    if (!row || (!isAdmin && row.userId !== callerId)) throw new MobileError('NOT_FOUND', 'no such device');
    return row;
  }

  remove(callerId: number | null, isAdmin: boolean, id: number): void {
    const row = this.owned(callerId, isAdmin, id);
    this.opts.db.delete(mobileDevices).where(eq(mobileDevices.id, row.id)).run();
    this.opts.log?.info({ device: row.id, user: row.userId }, 'mobile device removed');
  }

  // ---- sending -----------------------------------------------------------------------

  /** The relay body for a push payload: same title / body as web push, deep link and server in `data`. */
  bodyFor(deviceId: string, payload: PushPayload): RelaySendBody {
    const server = this.serverUrl();
    const data: Record<string, string> = {};
    if (payload.url) data['url'] = payload.url;
    if (server) data['server'] = server;
    data['channel'] = channelFor(payload.tag);
    return {
      deviceId,
      title: clip(payload.title, MAX_TITLE_CHARS),
      body: clip(payload.body ?? '', MAX_BODY_CHARS),
      ...(Object.keys(data).length > 0 ? { data } : {}),
      ...(payload.tag ? { threadId: payload.tag } : {}),
    };
  }

  /** Send `payload` to every device of `userId`. Resolves when the first attempts are done (retries run later). */
  async deliver(userId: number, payload: PushPayload): Promise<DeliveryResult> {
    const result: DeliveryResult = { sent: 0, removed: 0, failed: 0, deferred: 0 };
    if (!this.opts.enabled || this.disposed) return result;
    const rows = this.opts.db.select().from(mobileDevices).where(eq(mobileDevices.userId, userId)).all();
    await Promise.all(
      rows.map(async (row) => {
        const outcome = await this.attempt(row.id, payload, 0);
        result[outcome] += 1;
      }),
    );
    return result;
  }

  /** One send to one device (by id: the row is re-read, so a retry sees removals and new secrets). */
  private async attempt(deviceId: number, payload: PushPayload, attempt: number): Promise<keyof DeliveryResult> {
    const row = this.opts.db.select().from(mobileDevices).where(eq(mobileDevices.id, deviceId)).get();
    if (!row) return 'failed';
    if (this.now() < this.pausedUntil) return this.defer(row, payload, attempt, this.pauseReason);
    const outcome = await this.relay.send(row.relaySecret, this.bodyFor(row.relayDeviceId, payload));
    return this.settle(row, outcome, payload, attempt);
  }

  private settle(row: DeviceRow, outcome: RelayOutcome, payload: PushPayload, attempt: number): keyof DeliveryResult {
    const { db } = this.opts;
    switch (outcome.kind) {
      case 'sent':
        this.failures = 0;
        if (row.lastError) db.update(mobileDevices).set({ lastError: null }).where(eq(mobileDevices.id, row.id)).run();
        return 'sent';
      case 'gone':
        db.delete(mobileDevices).where(eq(mobileDevices.id, row.id)).run();
        this.opts.log?.info({ device: row.id, status: outcome.status }, 'mobile device gone at the push relay; removed');
        return 'removed';
      case 'retry': {
        const base = this.opts.baseBackoffMs ?? BASE_BACKOFF_MS;
        const max = this.opts.maxBackoffMs ?? MAX_BACKOFF_MS;
        const delay = outcome.retryAfterMs !== undefined ? Math.min(outcome.retryAfterMs, MAX_RETRY_AFTER_MS) : Math.min(max, base * 2 ** this.failures);
        this.failures += 1;
        this.pausedUntil = Math.max(this.pausedUntil, this.now() + delay);
        this.pauseReason = outcome.message;
        this.opts.log?.warn({ device: row.id, status: outcome.status, pauseMs: delay }, `mobile push: ${outcome.message}`);
        return this.defer(row, payload, attempt, outcome.message);
      }
      case 'failed':
        this.recordError(row.id, outcome.message);
        this.opts.log?.warn({ device: row.id, status: outcome.status }, `mobile push: ${outcome.message}`);
        return 'failed';
    }
  }

  /** Retry once when the pause ends; a second failure (or a full retry queue) drops the send. */
  private defer(row: DeviceRow, payload: PushPayload, attempt: number, message: string): keyof DeliveryResult {
    this.recordError(row.id, message);
    if (attempt > 0 || this.timers.size >= MAX_PENDING_RETRIES || this.disposed) return 'failed';
    const wait = Math.max(0, this.pausedUntil - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed) return;
      this.attempt(row.id, payload, attempt + 1).catch((err: unknown) => this.opts.log?.warn({ err, device: row.id }, 'mobile push retry failed'));
    }, wait);
    timer.unref?.();
    this.timers.add(timer);
    return 'deferred';
  }

  private recordError(id: number, message: string): void {
    this.opts.db.update(mobileDevices).set({ lastError: message }).where(eq(mobileDevices.id, id)).run();
  }

  /** "Send test notification" for one device, answered directly (no retry). Rate limited per device. */
  async test(callerId: number | null, isAdmin: boolean, id: number): Promise<MobileTestResult> {
    const row = this.owned(callerId, isAdmin, id);
    if (!this.opts.enabled) return { ok: false, outcome: 'disabled', message: 'mobile push is turned off on this server (ARCLIGHT_PUSH_RELAY=off)' };
    const now = this.now();
    const last = this.lastTest.get(row.id);
    if (last !== undefined && now - last < TEST_INTERVAL_MS) throw new MobileError('RATE_LIMITED', 'wait a few seconds before sending another test');
    this.lastTest.set(row.id, now);
    if (now < this.pausedUntil) return { ok: false, outcome: 'rate_limited', message: 'the push relay asked us to slow down; try again shortly' };
    const outcome = await this.relay.send(row.relaySecret, this.bodyFor(row.relayDeviceId, { title: 'Arclight', body: 'Notifications on this device are on.', url: '/profile', tag: 'mobile-test' }));
    const settled = this.settle(row, outcome, { title: '' }, 1);
    if (settled === 'sent') return { ok: true, outcome: 'sent' };
    if (settled === 'removed') return { ok: false, outcome: 'removed', message: 'the push relay no longer knows this device; it was removed. Turn notifications on again in the app.' };
    if (outcome.kind === 'retry' && outcome.status === 429) return { ok: false, outcome: 'rate_limited', message: outcome.message };
    return { ok: false, outcome: 'failed', message: outcome.kind === 'sent' || outcome.kind === 'gone' ? 'failed' : outcome.message };
  }

  /** Stop pending retries (app shutdown). */
  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Pending retry count (tests). */
  get pendingRetries(): number {
    return this.timers.size;
  }
}

/**
 * The Android notification channel the app created for a push (requests, downloads, health,
 * general), from the payload tag the push listener sets. A channel the app does not know makes
 * Android drop the notification, so anything unrecognised goes to `general`.
 */
export function channelFor(tag: string | undefined): 'requests' | 'downloads' | 'health' | 'general' {
  if (!tag) return 'general';
  if (tag.startsWith('request-')) return 'requests';
  if (tag.startsWith('available-')) return 'downloads';
  if (tag.startsWith('health')) return 'health';
  return 'general';
}
