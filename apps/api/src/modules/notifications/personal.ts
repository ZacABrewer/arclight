import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { createAgent, NotificationError, parseAgentSettings, redactSecrets, testEvent, type NotificationAgent, type NotificationEvent } from '@arclight/notifications';
import {
  hasAnyPermission,
  MANAGER_PERSONAL_EVENTS,
  Permission,
  PERSONAL_NOTIFICATION_EVENTS,
  PersonalDestinationInput,
  PersonalDestinationTestRequest,
  PersonalNotificationImplementation,
  type NotificationDelivery,
  type NotificationSchema,
  type NotificationTestResult,
  type PersonalDestination,
  type PersonalDestinationInputRaw,
  type PersonalDestinationOptions,
  type PersonalNotificationEvent,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { users } from '../auth/schema.js';
import { watchlistItems } from '../requests/schema.js';
import { getSection } from '../settings/service.js';
import { DeliveryLog, RateLimiter, realSleep, sendWithRetry, targetKey, type SendResult, type Sleep } from './delivery.js';
import { allSchemas, maskSettings, supportedEventsFor, unmaskSettings } from './fields.js';
import { bypassesQuietHours, isQuietAt } from './quiet-hours.js';
import { userNotificationDestinations, userNotificationHeld, type HeldReason, type UserNotificationDestinationRow } from './schema.js';
import { HELD_ALERT_MAX_AGE_MS, normalizeTemplates, NotificationsError, type AgentFactory, type DispatchOutcome, type LibraryEventListener } from './service.js';

// Personal destinations: each user's own notification targets (their Telegram chat, ntfy
// topic, Discord webhook...) and the events about their own activity they want there. The
// requests module calls `dispatch` for request and issue events; the system dispatcher
// forwards imports so titles on a user's watchlist reach them.

/** Personal destinations send at most this many messages a minute; extra ones wait for the next batch. */
export const PERSONAL_RATE_LIMIT_PER_MINUTE = 20;
export const PERSONAL_MAX_ATTEMPTS = 3;
/** Destinations per user. */
export const PERSONAL_DESTINATION_LIMIT = 20;

const PERSONAL_KINDS: ReadonlySet<string> = new Set(PersonalNotificationImplementation.options);

export interface PersonalNotificationsOptions {
  db: Db;
  log?: Logger;
  agentFactory?: AgentFactory;
  now?: () => Date;
  sleep?: Sleep;
  instanceName?: string;
  deliveries?: DeliveryLog;
  limiter?: RateLimiter;
  /** Whether personal destinations are switched on (settings section `alerts`). */
  enabled?: () => boolean;
}

interface Owner {
  id: number;
  isAdmin: boolean;
  permissions: number;
}

export class PersonalNotifications implements LibraryEventListener {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly factory: AgentFactory;
  private readonly now: () => Date;
  private readonly sleep: Sleep;
  private readonly instanceName: string;
  private readonly deliveryLog: DeliveryLog;
  private readonly limiter: RateLimiter;
  private readonly enabled: () => boolean;

  constructor(options: PersonalNotificationsOptions) {
    this.db = options.db;
    this.log = options.log;
    this.factory = options.agentFactory ?? ((kind, settings, templates) => createAgent(kind, settings, templates ? { templates } : {}));
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? realSleep;
    this.instanceName = options.instanceName ?? 'Arclight';
    this.deliveryLog = options.deliveries ?? new DeliveryLog(this.db, this.now);
    this.limiter = options.limiter ?? new RateLimiter();
    this.enabled = options.enabled ?? (() => readEnabled(this.db));
  }

  // ---- CRUD ------------------------------------------------------------------------------

  options(userId: number): PersonalDestinationOptions & { schemas: NotificationSchema[] } {
    const owner = this.owner(userId);
    return {
      enabled: this.enabled(),
      implementations: [...PersonalNotificationImplementation.options],
      events: allowedEvents(owner),
      schemas: allSchemas().filter((s) => PERSONAL_KINDS.has(s.implementation)),
    };
  }

  list(userId: number, viewerIsAdmin = true): PersonalDestination[] {
    this.owner(userId);
    return this.rowsOf(userId).map((r) => this.resource(r, viewerIsAdmin));
  }

  create(userId: number, raw: PersonalDestinationInputRaw): PersonalDestination {
    const owner = this.owner(userId);
    this.assertOn();
    if (this.rowsOf(userId).length >= PERSONAL_DESTINATION_LIMIT) {
      throw new NotificationsError('VALIDATION', `At most ${PERSONAL_DESTINATION_LIMIT} personal destinations`);
    }
    const values = this.normalize(owner, raw, null);
    const now = this.now().toISOString();
    const row = this.db
      .insert(userNotificationDestinations)
      .values({ ...values, userId, addedAt: now, updatedAt: now })
      .returning()
      .get();
    return this.resource(row, true);
  }

  update(userId: number, id: number, raw: PersonalDestinationInputRaw): PersonalDestination {
    const owner = this.owner(userId);
    const existing = this.requireRow(userId, id);
    const values = this.normalize(owner, raw, existing);
    const row = this.db
      .update(userNotificationDestinations)
      .set({ ...values, updatedAt: this.now().toISOString() })
      .where(eq(userNotificationDestinations.id, id))
      .returning()
      .get();
    if (!row) throw notFound(id);
    this.limiter.forget(targetKey({ destinationId: id }));
    return this.resource(row, true);
  }

  delete(userId: number, id: number): void {
    this.requireRow(userId, id);
    this.db.delete(userNotificationDestinations).where(eq(userNotificationDestinations.id, id)).run();
    this.limiter.forget(targetKey({ destinationId: id }));
  }

  deliveries(userId: number, id: number, viewerIsAdmin = true): NotificationDelivery[] {
    this.requireRow(userId, id);
    const rows = this.deliveryLog.list({ destinationId: id });
    return viewerIsAdmin ? rows : rows.map((d) => (d.error ? { ...d, error: publicError(d.code) } : d));
  }

  /** Sends a test through the candidate (masked secrets are restored from the saved one). */
  async test(userId: number, raw: z.input<typeof PersonalDestinationTestRequest>, viewerIsAdmin = true): Promise<NotificationTestResult> {
    const owner = this.owner(userId);
    this.assertOn();
    const parsed = PersonalDestinationTestRequest.safeParse(raw);
    if (!parsed.success) throw new NotificationsError('VALIDATION', z.prettifyError(parsed.error));
    const { id, ...candidate } = parsed.data;
    const existing = id === undefined ? null : this.requireRow(userId, id);
    const values = this.normalize(owner, candidate, existing);
    const event = testEvent(this.instanceName, this.now);
    let result: SendResult;
    try {
      const agent = this.factory(values.implementation, values.settings, values.templates);
      result = await sendWithRetry(() => agent.send(event), { maxAttempts: 1, sleep: this.sleep, redact: (t) => redactSecrets(t, values.settings) });
    } catch (err) {
      result = { ok: false, attempts: 1, error: redactSecrets(errorMessage(err), values.settings), ...(err instanceof NotificationError ? { code: err.code } : {}) };
    }
    if (existing) {
      this.deliveryLog.add(
        { destinationId: existing.id },
        { event, templates: values.templates, state: result.ok ? 'sent' : 'failed', attempts: result.attempts, error: result.error, code: result.code, test: true },
      );
    }
    if (result.ok) return { ok: true };
    return {
      ok: false,
      message: viewerIsAdmin ? (result.error ?? 'failed') : publicError(result.code, result.status),
      ...(result.code ? { code: result.code } : {}),
    };
  }

  // ---- dispatch ------------------------------------------------------------------------------

  /**
   * Deliver `event` to the destinations of `userId` that chose `key`. Quiet hours (the
   * destination's own) hold non-urgent alerts; a fixed rate limit holds bursts. Never throws.
   */
  async dispatch(userId: number, key: PersonalNotificationEvent, event: NotificationEvent): Promise<DispatchOutcome[]> {
    if (!this.enabled()) return [];
    const ownerRow = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!ownerRow) return [];
    const owner = ownerOf(ownerRow);
    if (!allowedEvents(owner).includes(key)) return [];
    const rows = this.rowsOf(userId).filter((r) => r.enabled && r.events.includes(key));
    const now = this.now();
    const outcomes = await Promise.all(
      rows.map(async (row): Promise<DispatchOutcome | null> => {
        const target = { destinationId: row.id };
        let agent: NotificationAgent;
        try {
          agent = this.factory(row.implementation, row.settings, row.templates);
        } catch (err) {
          const message = redactSecrets(errorMessage(err), row.settings);
          this.deliveryLog.add(target, { event, templates: row.templates, state: 'failed', error: message });
          return { id: row.id, name: row.name, ok: false, error: message };
        }
        if (!agent.supportedEvents.has(event.type)) return null;
        if (row.quietHours && isQuietAt(row.quietHours, now) && !bypassesQuietHours(event)) {
          this.hold(row.id, event, 'quiet');
          this.deliveryLog.add(target, { event, templates: row.templates, state: 'held' });
          return { id: row.id, name: row.name, ok: true, held: true };
        }
        if (!this.limiter.take(targetKey(target), PERSONAL_RATE_LIMIT_PER_MINUTE, now.getTime())) {
          this.hold(row.id, event, 'rate');
          this.deliveryLog.add(target, { event, templates: row.templates, state: 'rateLimited' });
          return { id: row.id, name: row.name, ok: true, held: true, rateLimited: true };
        }
        const result = await sendWithRetry(() => agent.send(event), {
          maxAttempts: PERSONAL_MAX_ATTEMPTS,
          sleep: this.sleep,
          redact: (t) => redactSecrets(t, row.settings),
        });
        this.deliveryLog.add(target, {
          event,
          templates: row.templates,
          state: result.ok ? 'sent' : 'failed',
          attempts: result.attempts,
          error: result.error,
          code: result.code,
        });
        if (!result.ok) {
          this.log?.warn({ userId, destination: row.id, error: result.error, event: event.type }, 'personal notification failed');
        }
        return { id: row.id, name: row.name, ok: result.ok, attempts: result.attempts, ...(result.error ? { error: result.error } : {}) };
      }),
    );
    return outcomes.filter((o): o is DispatchOutcome => o !== null);
  }

  /**
   * An import reached the library: everyone with the title on their watchlist hears about it
   * (`watchlistAvailable`). Upgrades are replacements, not new episodes, so they are skipped.
   */
  async libraryEvent(event: NotificationEvent): Promise<DispatchOutcome[]> {
    if (event.type !== 'import' || !this.enabled()) return [];
    const media = event.media;
    if ((media.mediaType !== 'series' && media.mediaType !== 'movie') || !media.tmdbId) return [];
    const watchers = this.db
      .selectDistinct({ userId: watchlistItems.userId })
      .from(watchlistItems)
      .where(and(eq(watchlistItems.mediaType, media.mediaType), eq(watchlistItems.tmdbId, media.tmdbId)))
      .all();
    const results = await Promise.all(watchers.map((w) => this.dispatch(w.userId, 'watchlistAvailable', event)));
    return results.flat();
  }

  private hold(destinationId: number, event: NotificationEvent, reason: HeldReason): void {
    this.db.insert(userNotificationHeld).values({ destinationId, event, heldAt: this.now().toISOString(), reason }).run();
  }

  /** Send what quiet hours or the rate limit held, once each destination may. Returns alerts delivered. */
  async flushHeld(): Promise<number> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - HELD_ALERT_MAX_AGE_MS).toISOString();
    this.db.delete(userNotificationHeld).where(lt(userNotificationHeld.heldAt, cutoff)).run();
    const held = this.db.select().from(userNotificationHeld).orderBy(asc(userNotificationHeld.id)).all();
    if (held.length === 0) return 0;
    const byDestination = new Map<number, typeof held>();
    for (const h of held) byDestination.set(h.destinationId, [...(byDestination.get(h.destinationId) ?? []), h]);
    const rows = new Map(
      this.db
        .select()
        .from(userNotificationDestinations)
        .where(inArray(userNotificationDestinations.id, [...byDestination.keys()]))
        .all()
        .map((r) => [r.id, r]),
    );
    let delivered = 0;
    for (const [id, items] of byDestination) {
      const row = rows.get(id);
      const ids = items.map((h) => h.id);
      if (!row || !row.enabled || !this.enabled()) {
        this.db.delete(userNotificationHeld).where(inArray(userNotificationHeld.id, ids)).run();
        continue;
      }
      if (row.quietHours && isQuietAt(row.quietHours, now)) continue;
      const key = targetKey({ destinationId: id });
      if (!this.limiter.hasRoom(key, PERSONAL_RATE_LIMIT_PER_MINUTE, now.getTime())) continue;
      const first = items[0]!;
      const event: NotificationEvent =
        items.length === 1
          ? first.event
          : {
              type: 'heldAlerts',
              instanceName: first.event.instanceName,
              timestamp: now.toISOString(),
              ...(first.event.applicationUrl ? { applicationUrl: first.event.applicationUrl } : {}),
              events: items.map((h) => h.event),
              heldSince: first.heldAt,
            };
      this.limiter.note(key, now.getTime());
      let agent: NotificationAgent;
      try {
        agent = this.factory(row.implementation, row.settings, row.templates);
      } catch {
        continue;
      }
      const result = await sendWithRetry(() => agent.send(event), {
        maxAttempts: PERSONAL_MAX_ATTEMPTS,
        sleep: this.sleep,
        redact: (t) => redactSecrets(t, row.settings),
      });
      this.deliveryLog.add(
        { destinationId: id },
        { event, templates: row.templates, state: result.ok ? 'sent' : 'failed', attempts: result.attempts, error: result.error, code: result.code },
      );
      if (result.ok) {
        this.db.delete(userNotificationHeld).where(inArray(userNotificationHeld.id, ids)).run();
        delivered += items.length;
      }
    }
    return delivered;
  }

  // ---- helpers ------------------------------------------------------------------------------

  private resource(row: UserNotificationDestinationRow, viewerIsAdmin: boolean): PersonalDestination {
    const status = this.deliveryLog.status({ destinationId: row.id });
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      implementation: row.implementation,
      enabled: row.enabled,
      events: row.events,
      settings: maskSettings(row.settings),
      templates: row.templates,
      quietHours: row.quietHours ?? null,
      status: viewerIsAdmin || !status.lastError ? status : { ...status, lastError: publicError(undefined) },
      addedAt: row.addedAt,
      updatedAt: row.updatedAt,
    };
  }

  private normalize(owner: Owner, raw: PersonalDestinationInputRaw, existing: UserNotificationDestinationRow | null) {
    const parsed = PersonalDestinationInput.safeParse(raw);
    if (!parsed.success) throw new NotificationsError('VALIDATION', z.prettifyError(parsed.error));
    const input = parsed.data;
    const stored = existing && existing.implementation === input.implementation ? existing.settings : null;
    const merged = unmaskSettings(input.settings, stored);
    let settings: Record<string, unknown>;
    try {
      settings = parseAgentSettings(input.implementation, merged) as Record<string, unknown>;
    } catch (err) {
      throw new NotificationsError('VALIDATION', errorMessage(err), { cause: err });
    }
    if (!owner.isAdmin) {
      const blocked = privateTarget(settings);
      if (blocked) {
        throw new NotificationsError('VALIDATION', `${blocked} is a local network address; only admins can send personal notifications there`);
      }
    }
    const allowed = new Set(allowedEvents(owner));
    const supported = supportedEventsFor(input.implementation, settings);
    if (!supported.has('requestApproved')) {
      throw new NotificationsError('VALIDATION', `${input.implementation} cannot deliver personal notifications`);
    }
    return {
      name: input.name,
      implementation: input.implementation,
      enabled: input.enabled,
      events: [...new Set(input.events)].filter((e) => allowed.has(e)),
      settings,
      templates: normalizeTemplates(input.templates),
      quietHours: input.quietHours,
    };
  }

  private assertOn(): void {
    if (!this.enabled()) throw new NotificationsError('VALIDATION', 'Personal notifications are switched off on this server');
  }

  private owner(userId: number): Owner {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) throw new NotificationsError('NOT_FOUND', `User ${userId} not found`);
    return ownerOf(row);
  }

  private rowsOf(userId: number): UserNotificationDestinationRow[] {
    return this.db
      .select()
      .from(userNotificationDestinations)
      .where(eq(userNotificationDestinations.userId, userId))
      .orderBy(asc(userNotificationDestinations.id))
      .all();
  }

  private requireRow(userId: number, id: number): UserNotificationDestinationRow {
    const row = this.db
      .select()
      .from(userNotificationDestinations)
      .where(and(eq(userNotificationDestinations.id, id), eq(userNotificationDestinations.userId, userId)))
      .get();
    if (!row) throw notFound(id);
    return row;
  }
}

function ownerOf(row: { id: number; role: string; permissions: number }): Owner {
  const isAdmin = row.role === 'admin';
  return { id: row.id, isAdmin, permissions: isAdmin ? row.permissions | Permission.ADMIN : row.permissions & ~Permission.ADMIN };
}

/** Events `owner` may pick: everyone gets their own; managers also hear about new requests / issues. */
export function allowedEvents(owner: Pick<Owner, 'permissions'>): PersonalNotificationEvent[] {
  return PERSONAL_NOTIFICATION_EVENTS.filter((e) => {
    if (!MANAGER_PERSONAL_EVENTS.includes(e)) return true;
    return hasAnyPermission(owner.permissions, [e === 'requestPending' ? Permission.MANAGE_REQUESTS : Permission.MANAGE_ISSUES]);
  });
}

/**
 * The first URL or host in `settings` that points at this machine or the local network, or
 * undefined. Personal destinations of non-admins must not make the server call into the LAN.
 * Literal addresses and local-only names are caught; a public name resolving to a private
 * address is not (admins can switch personal destinations off).
 */
export function privateTarget(settings: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(settings)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v !== 'string') continue;
      let host: string | undefined;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
        try {
          host = new URL(v).hostname;
        } catch {
          continue;
        }
      } else if (key === 'host') {
        host = v;
      }
      if (host && isPrivateHost(host)) return host;
    }
  }
  return undefined;
}

export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(local|lan|internal|home\.arpa|intranet|corp|home)$/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    return mapped ? isPrivateHost(mapped[1]!) : false;
  }
  // A single-label name (a container or LAN host name) only resolves locally.
  return !host.includes('.');
}

/**
 * What a non-admin sees instead of the error text: the remote server's answer can quote
 * whatever it serves, so only the category is shown.
 */
export function publicError(code: string | undefined, status?: number): string {
  const http = status !== undefined ? ` (HTTP ${status})` : '';
  switch (code) {
    case 'network':
      return 'Could not reach the service';
    case 'timeout':
      return 'The service did not answer in time';
    case 'unauthorized':
      return `The service refused the credentials${http}`;
    case 'notFound':
      return `The service did not find the target${http}`;
    case 'rateLimited':
      return 'The service is rate limiting messages';
    case 'invalidSettings':
      return 'The settings are not valid';
    case 'remoteError':
      return `The service answered with an error${http}`;
    default:
      return 'Delivery failed';
  }
}

function readEnabled(db: Db): boolean {
  try {
    return getSection(db, 'alerts').personalDestinations;
  } catch {
    return true;
  }
}

function notFound(id: number): NotificationsError {
  return new NotificationsError('NOT_FOUND', `Notification destination ${id} not found`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
