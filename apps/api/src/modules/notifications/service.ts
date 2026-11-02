import { and, asc, count, eq, inArray, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  applyTemplate,
  createAgent,
  formatEvent,
  NOTIFICATION_EVENT_TYPES,
  NotificationError,
  parseAgentSettings,
  redactSecrets,
  sampleEvent,
  TEMPLATE_KEYS,
  TEMPLATE_VARIABLES,
  templateContext,
  testEvent,
  validateTemplate,
  type MessageTemplates,
  type NotificationAgent,
  type NotificationAgentKind,
  type NotificationEvent,
  type NotificationEventType,
} from '@arclight/notifications';
import {
  NOTIFICATION_TRIGGERS,
  NotificationInput,
  NotificationTestRequest,
  type NotificationConnection,
  type NotificationDelivery,
  type NotificationPreview,
  type NotificationPreviewRequest,
  type NotificationTemplateMeta,
  type NotificationTemplates,
  type NotificationInputRaw,
  type NotificationSchema,
  type NotificationTestAllResult,
  type NotificationTestResult,
  type NotificationTrigger,
  type QuietHoursSettings,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { tags as tagsTable } from '../../db/schema.js';
import { getSection } from '../settings/service.js';
import { allSchemas, capabilitiesFrom, maskSettings, supportedEventsFor, TRIGGER_EVENT, unmaskSettings } from './fields.js';
import { bypassesQuietHours, isQuietAt } from './quiet-hours.js';
import { notificationHeld, notifications, type HeldReason, type NotificationRow } from './schema.js';
import { DeliveryLog, passesFilters, RateLimiter, realSleep, sendWithRetry, targetKey, type Sleep } from './delivery.js';

export type NotificationsErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT';

export class NotificationsError extends Error {
  constructor(
    readonly code: NotificationsErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NotificationsError';
  }
}

/** Builds an agent from validated settings and the destination's templates. Injected in tests. */
export type AgentFactory = (kind: NotificationAgentKind, settings: unknown, templates?: MessageTemplates) => NotificationAgent;

/** Personal destinations hear about library events (watchlist titles) from the dispatcher. */
export interface LibraryEventListener {
  libraryEvent(event: NotificationEvent): Promise<unknown>;
}

export interface NotificationsServiceOptions {
  db: Db;
  log?: Logger;
  agentFactory?: AgentFactory;
  now?: () => Date;
  instanceName?: string;
  /** Quiet hours in effect; defaults to the `alerts` settings section. */
  quietHours?: () => QuietHoursSettings;
  /** Waits between retries. Injected in tests. */
  sleep?: Sleep;
  /** Shared with the personal destinations so both write one log. */
  deliveries?: DeliveryLog;
  limiter?: RateLimiter;
}

export interface DispatchOutcome {
  id: number;
  name: string;
  ok: boolean;
  error?: string;
  /** Held for quiet hours (or the rate limit) rather than sent. */
  held?: boolean;
  /** Held because the connection's rate limit was reached. */
  rateLimited?: boolean;
  /** Attempts made (retries included). */
  attempts?: number;
}

/** Held alerts older than this are dropped instead of delivered (the connection kept failing). */
export const HELD_ALERT_MAX_AGE_MS = 7 * 86_400_000;

/** Per-connection delivery health, in memory (feeds the notification health check). */
export interface ConnectionStatus {
  consecutiveFailures: number;
  lastError?: string;
  lastFailureAt?: string;
  lastSuccessAt?: string;
}

export class NotificationsService {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly factory: AgentFactory;
  private readonly now: () => Date;
  private readonly instanceName: string;
  private readonly status = new Map<number, ConnectionStatus>();
  private readonly quietHours: () => QuietHoursSettings;
  private readonly sleep: Sleep;
  readonly deliveryLog: DeliveryLog;
  readonly limiter: RateLimiter;
  private listener: LibraryEventListener | undefined;

  constructor(options: NotificationsServiceOptions) {
    this.db = options.db;
    this.log = options.log;
    this.factory = options.agentFactory ?? ((kind, settings, templates) => createAgent(kind, settings, templates ? { templates } : {}));
    this.now = options.now ?? (() => new Date());
    this.instanceName = options.instanceName ?? 'Arclight';
    this.quietHours = options.quietHours ?? (() => readQuietHours(this.db));
    this.sleep = options.sleep ?? realSleep;
    this.deliveryLog = options.deliveries ?? new DeliveryLog(this.db, this.now);
    this.limiter = options.limiter ?? new RateLimiter();
  }

  /** Personal destinations subscribe here for watchlist (import) events. */
  setLibraryListener(listener: LibraryEventListener | undefined): void {
    this.listener = listener;
  }

  // ---- CRUD ------------------------------------------------------------------------------

  list(): NotificationConnection[] {
    return this.rows().map((r) => this.resource(r));
  }

  get(id: number): NotificationConnection {
    return this.resource(this.requireRow(id));
  }

  private resource(row: NotificationRow): NotificationConnection {
    return { ...toResource(row), status: this.deliveryLog.status({ notificationId: row.id }) };
  }

  /** The delivery log of one connection, newest first. */
  deliveries(id: number): NotificationDelivery[] {
    this.requireRow(id);
    return this.deliveryLog.list({ notificationId: id });
  }

  // ---- templates -----------------------------------------------------------------------------

  templateMeta(): NotificationTemplateMeta {
    return { keys: [...TEMPLATE_KEYS], variables: TEMPLATE_VARIABLES.map((v) => ({ ...v })) };
  }

  /** Render `template` against a sample event of `eventType` (`default`: a sample import). */
  preview(req: NotificationPreviewRequest): NotificationPreview {
    return previewTemplate(req, this.instanceName, this.now());
  }

  schemas(): NotificationSchema[] {
    return allSchemas();
  }

  create(raw: NotificationInputRaw): NotificationConnection {
    const values = this.normalize(raw, null);
    this.assertUniqueName(values.name, null);
    const now = this.now().toISOString();
    const row = this.db
      .insert(notifications)
      .values({ ...values, addedAt: now, updatedAt: now })
      .returning()
      .get();
    return this.resource(row);
  }

  update(id: number, raw: NotificationInputRaw): NotificationConnection {
    const existing = this.requireRow(id);
    const values = this.normalize(raw, existing);
    this.assertUniqueName(values.name, id);
    const row = this.db
      .update(notifications)
      .set({ ...values, updatedAt: this.now().toISOString() })
      .where(eq(notifications.id, id))
      .returning()
      .get();
    if (!row) throw notFound(id);
    this.status.delete(id);
    this.limiter.forget(targetKey({ notificationId: id }));
    return this.resource(row);
  }

  delete(id: number): void {
    this.requireRow(id);
    this.db.delete(notifications).where(eq(notifications.id, id)).run();
    this.status.delete(id);
  }

  // ---- tests -------------------------------------------------------------------------------

  /** Sends a `test` event through the candidate configuration (masked secrets are restored). */
  async test(raw: z.input<typeof NotificationTestRequest>): Promise<NotificationTestResult> {
    const parsed = NotificationTestRequest.safeParse(raw);
    if (!parsed.success) throw new NotificationsError('VALIDATION', z.prettifyError(parsed.error));
    const { id, ...candidate } = parsed.data;
    const existing = id === undefined ? null : this.requireRow(id);
    const values = this.normalize(candidate, existing);
    const result = await this.sendTest(values.implementation, values.settings, values.templates);
    // A saved connection keeps the test in its delivery log (the editor shows the last error).
    if (existing) this.logTest(existing.id, values.templates, result);
    return result;
  }

  async testAll(): Promise<NotificationTestAllResult> {
    const results: NotificationTestAllResult = [];
    for (const row of this.rows().filter((r) => r.enabled)) {
      const result = await this.sendTest(row.implementation, row.settings, row.templates);
      this.record(row.id, result.ok ? undefined : (result.message ?? 'test failed'));
      this.logTest(row.id, row.templates, result);
      results.push({ id: row.id, name: row.name, ...result });
    }
    return results;
  }

  private logTest(id: number, templates: NotificationTemplates, result: NotificationTestResult): void {
    this.deliveryLog.add(
      { notificationId: id },
      {
        event: testEvent(this.instanceName, this.now),
        templates,
        state: result.ok ? 'sent' : 'failed',
        error: result.message,
        code: result.code,
        test: true,
      },
    );
  }

  private async sendTest(kind: NotificationAgentKind, settings: Record<string, unknown>, templates: NotificationTemplates): Promise<NotificationTestResult> {
    try {
      const agent = this.factory(kind, settings, templates);
      await agent.send(testEvent(this.instanceName, this.now));
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: redactSecrets(err instanceof Error ? err.message : String(err), settings),
        ...(err instanceof NotificationError ? { code: err.code } : {}),
      };
    }
  }

  // ---- dispatch ------------------------------------------------------------------------------

  /**
   * Deliver `event` to every enabled connection whose trigger flags, health-warning option,
   * tags, filters and agent capabilities accept it. Each connection is independent: its own
   * quiet hours and rate limit may hold the alert, and failed sends are retried with backoff.
   * Failures are logged (secrets redacted) and recorded per connection. Resolves once every
   * send settled.
   */
  async dispatch(event: NotificationEvent): Promise<DispatchOutcome[]> {
    const library = this.notifyListener(event);
    const outcomes = await this.dispatchToConnections(event);
    await library;
    return outcomes;
  }

  private notifyListener(event: NotificationEvent): Promise<unknown> {
    if (!this.listener || (event.type !== 'import' && event.type !== 'upgrade')) return Promise.resolve();
    return this.listener.libraryEvent(event).catch((err: unknown) => this.log?.warn({ err, event: event.type }, 'personal notifications failed'));
  }

  private async dispatchToConnections(event: NotificationEvent): Promise<DispatchOutcome[]> {
    const rows = this.rows().filter((r) => r.enabled && wantsEvent(r, event) && passesFilters(r.filters, event));
    if (rows.length === 0) return [];
    const globalQuiet = this.quietHours();
    const now = this.now();
    // A kill-switch reminder only goes to connections that held the original alert.
    const reminder = event.type === 'killSwitch' && event.pausedMinutes !== undefined;
    const mediaTags = 'media' in event && event.media ? new Set(event.media.tags) : null;
    const labels = this.tagLabelMap(rows.flatMap((r) => r.tags));

    const targets = rows.filter((row) => {
      if (row.tags.length === 0 || mediaTags === null) return true;
      return row.tags.some((id) => {
        const label = labels.get(id);
        return label !== undefined && mediaTags.has(label);
      });
    });

    const outcomes = await Promise.all(
      targets.map(async (row): Promise<DispatchOutcome | null> => {
        const target = { notificationId: row.id };
        let agent: NotificationAgent;
        try {
          agent = this.factory(row.implementation, row.settings, row.templates);
        } catch (err) {
          const message = redactSecrets(errorMessage(err), row.settings);
          this.log?.warn({ error: message, notification: row.name }, 'notification connection is misconfigured');
          this.record(row.id, message);
          this.deliveryLog.add(target, { event, templates: row.templates, state: 'failed', error: message, code: codeOf(err) });
          return { id: row.id, name: row.name, ok: false, error: message };
        }
        if (!agent.supportedEvents.has(event.type)) return null;
        const holding = row.respectQuietHours && isQuietAt(row.quietHours ?? globalQuiet, now);
        if (reminder && !holding) return null;
        const urgent = bypassesQuietHours(event);
        if (holding && !urgent) {
          this.hold(row.id, event, 'quiet');
          this.deliveryLog.add(target, { event, templates: row.templates, state: 'held' });
          return { id: row.id, name: row.name, ok: true, held: true };
        }
        const key = targetKey(target);
        if (urgent) this.limiter.note(key, now.getTime());
        else if (!this.limiter.take(key, row.rateLimitPerMinute, now.getTime())) {
          this.hold(row.id, event, 'rate');
          this.deliveryLog.add(target, { event, templates: row.templates, state: 'rateLimited' });
          return { id: row.id, name: row.name, ok: true, held: true, rateLimited: true };
        }
        const result = await sendWithRetry(() => agent.send(event), {
          maxAttempts: row.maxAttempts,
          sleep: this.sleep,
          redact: (text) => redactSecrets(text, row.settings),
        });
        this.deliveryLog.add(target, {
          event,
          templates: row.templates,
          state: result.ok ? 'sent' : 'failed',
          attempts: result.attempts,
          error: result.error,
          code: result.code,
        });
        if (result.ok) {
          this.record(row.id, undefined);
          return { id: row.id, name: row.name, ok: true, attempts: result.attempts };
        }
        this.log?.warn(
          { error: result.error, code: result.code, attempts: result.attempts, notification: row.name, event: event.type },
          'notification failed',
        );
        this.record(row.id, result.error ?? 'failed');
        return { id: row.id, name: row.name, ok: false, error: result.error ?? 'failed', attempts: result.attempts };
      }),
    );
    return outcomes.filter((o): o is DispatchOutcome => o !== null);
  }

  // ---- quiet hours ---------------------------------------------------------------------------

  isQuietNow(): boolean {
    return isQuietAt(this.quietHours(), this.now());
  }

  heldCount(): number {
    return this.db.select({ n: count() }).from(notificationHeld).get()?.n ?? 0;
  }

  private hold(notificationId: number, event: NotificationEvent, reason: HeldReason): void {
    this.db.insert(notificationHeld).values({ notificationId, event, heldAt: this.now().toISOString(), reason }).run();
  }

  /**
   * Send each connection what was held for it once it may: when its quiet hours (its own, or
   * the global ones) are over, and when its rate limit has room again. One alert goes as
   * itself, more as a single `heldAlerts` batch. Delivered (and expired) rows are deleted; a
   * failed send keeps them for the next try. Returns the number of alerts delivered.
   */
  async flushHeld(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - HELD_ALERT_MAX_AGE_MS).toISOString();
    this.db.delete(notificationHeld).where(lt(notificationHeld.heldAt, cutoff)).run();
    const held = this.db.select().from(notificationHeld).orderBy(asc(notificationHeld.id)).all();
    if (held.length === 0) return 0;
    const byConnection = new Map<number, typeof held>();
    for (const h of held) byConnection.set(h.notificationId, [...(byConnection.get(h.notificationId) ?? []), h]);
    const rows = new Map(this.rows().map((r) => [r.id, r]));
    const globalQuiet = this.quietHours();
    const now = this.now();
    let delivered = 0;
    for (const [id, items] of byConnection) {
      const row = rows.get(id);
      if (!row || !row.enabled) {
        this.db.delete(notificationHeld).where(inArray(notificationHeld.id, items.map((h) => h.id))).run();
        continue;
      }
      // Nothing leaves while the connection is in its quiet hours, rate-limited alerts included.
      if (row.respectQuietHours && isQuietAt(row.quietHours ?? globalQuiet, now)) continue;
      const key = targetKey({ notificationId: id });
      if (!this.limiter.hasRoom(key, row.rateLimitPerMinute, now.getTime())) continue;
      const ids = items.map((h) => h.id);
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
      } catch (err) {
        this.record(id, redactSecrets(errorMessage(err), row.settings));
        continue;
      }
      const result = await sendWithRetry(() => agent.send(event), {
        maxAttempts: row.maxAttempts,
        sleep: this.sleep,
        redact: (text) => redactSecrets(text, row.settings),
      });
      this.deliveryLog.add(
        { notificationId: id },
        { event, templates: row.templates, state: result.ok ? 'sent' : 'failed', attempts: result.attempts, error: result.error, code: result.code },
      );
      if (result.ok) {
        this.record(id, undefined);
        this.db.delete(notificationHeld).where(and(eq(notificationHeld.notificationId, id), inArray(notificationHeld.id, ids))).run();
        delivered += items.length;
      } else {
        this.log?.warn({ error: result.error, notification: row.name, held: items.length }, 'could not deliver held alerts');
        this.record(id, result.error ?? 'failed');
      }
    }
    return delivered;
  }

  /** Delivery health per connection id since process start. */
  connectionStatuses(): Map<number, ConnectionStatus> {
    return new Map(this.status);
  }

  /** Enabled connections whose stored settings no longer validate, with the reason. */
  misconfigured(): Array<{ id: number; name: string; error: string }> {
    return this.rows()
      .filter((r) => r.enabled)
      .flatMap((r) => {
        try {
          parseAgentSettings(r.implementation, r.settings);
          return [];
        } catch (err) {
          return [{ id: r.id, name: r.name, error: errorMessage(err) }];
        }
      });
  }

  /** Raw rows (unmasked). For other api modules (health checks); never serve these. */
  rows(): NotificationRow[] {
    return this.db.select().from(notifications).orderBy(asc(notifications.id)).all();
  }

  // ---- helpers ------------------------------------------------------------------------------

  private record(id: number, error: string | undefined): void {
    const nowIso = this.now().toISOString();
    const prev = this.status.get(id) ?? { consecutiveFailures: 0 };
    if (error === undefined) {
      this.status.set(id, { ...prev, consecutiveFailures: 0, lastSuccessAt: nowIso });
    } else {
      this.status.set(id, { ...prev, consecutiveFailures: prev.consecutiveFailures + 1, lastError: error, lastFailureAt: nowIso });
    }
  }

  private tagLabelMap(ids: number[]): Map<number, string> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    return new Map(
      this.db
        .select()
        .from(tagsTable)
        .where(inArray(tagsTable.id, unique))
        .all()
        .map((t) => [t.id, t.label]),
    );
  }

  private normalize(raw: NotificationInputRaw, existing: NotificationRow | null) {
    const parsed = NotificationInput.safeParse(raw);
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
    // Triggers the agent cannot serve are stored off so the UI and dispatch agree.
    const supported = supportedEventsFor(input.implementation, settings);
    const triggers = Object.fromEntries(
      NOTIFICATION_TRIGGERS.map((t) => [t, input[t] && supported.has(TRIGGER_EVENT[t])]),
    ) as Record<NotificationTrigger, boolean>;
    return {
      name: input.name,
      implementation: input.implementation,
      enabled: input.enabled,
      ...triggers,
      includeHealthWarnings: input.includeHealthWarnings,
      respectQuietHours: input.respectQuietHours,
      tags: [...new Set(input.tags)],
      settings,
      filters: {
        mediaTypes: [...new Set(input.filters.mediaTypes)],
        qualities: [...new Set(input.filters.qualities.map((q) => q.trim()).filter(Boolean))],
        users: [...new Set(input.filters.users)],
      },
      templates: normalizeTemplates(input.templates),
      quietHours: input.quietHours,
      rateLimitPerMinute: input.rateLimitPerMinute,
      maxAttempts: input.maxAttempts,
    };
  }

  private assertUniqueName(name: string, selfId: number | null): void {
    const clash = this.rows().find((r) => r.id !== selfId && r.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new NotificationsError('CONFLICT', `A notification named "${name}" already exists`);
  }

  private requireRow(id: number): NotificationRow {
    const row = this.db.select().from(notifications).where(eq(notifications.id, id)).get();
    if (!row) throw notFound(id);
    return row;
  }
}

/** Trigger flag (and health severity rule) check for one connection. */
export function wantsEvent(row: Pick<NotificationRow, NotificationTrigger | 'includeHealthWarnings'>, event: NotificationEvent): boolean {
  switch (event.type) {
    case 'test':
      return true;
    case 'grab':
      return row.onGrab;
    case 'import':
      return row.onDownload;
    case 'upgrade':
      return row.onUpgrade;
    case 'rename':
      return row.onRename;
    case 'mediaAdded':
      return event.media.mediaType === 'series' ? row.onSeriesAdd : row.onMovieAdd;
    case 'mediaDeleted':
      return event.media.mediaType === 'series' ? row.onSeriesDelete : row.onMovieDelete;
    case 'fileDeleted':
      return row.onFileDelete;
    case 'healthIssue':
    case 'healthRestored': {
      const enabled = event.type === 'healthIssue' ? row.onHealthIssue : row.onHealthRestored;
      if (!enabled) return false;
      if (event.health.status === 'error') return true;
      return event.health.status === 'warning' && row.includeHealthWarnings;
    }
    case 'applicationUpdate':
      return row.onApplicationUpdate;
    case 'manualInteractionRequired':
      return row.onManualInteractionRequired;
    case 'requestCreated':
      return row.onRequestCreated;
    case 'requestApproved':
      return row.onRequestApproved;
    case 'requestDeclined':
      return row.onRequestDeclined;
    case 'requestAvailable':
      return row.onRequestAvailable;
    case 'issueCreated':
      return row.onIssueCreated;
    case 'issueUpdated':
      return row.onIssueUpdated;
    case 'retention':
      // Retention removes movies and series, so it follows the delete flags.
      return row.onMovieDelete || row.onSeriesDelete;
    case 'healthScan':
      // Broken library files are a health matter: they follow the health issue flag.
      return row.onHealthIssue;
    case 'fileTranscoded':
      // The file on disk changed name/format in place, like a rename.
      return row.onRename;
    case 'requestsDigest':
      // The daily digest goes wherever admins hear about new requests or issues.
      return row.onRequestCreated || row.onIssueCreated;
    case 'downloadStalled':
      return row.onDownloadStalled;
    case 'downloadRejected':
      return row.onDownloadRejected;
    case 'killSwitch':
      return row.onKillSwitch;
    case 'killSwitchResumed':
      return row.onKillSwitchResumed;
    case 'importProblem':
      return row.onImportProblem;
    case 'diskSpaceLow':
      return row.onDiskSpaceLow;
    case 'downloadUpdate':
      return row.onDownloadRecovered;
    case 'dailySummary':
      return row.onDailySummary;
    case 'heldAlerts':
      // Built from alerts this connection already accepted.
      return true;
    default:
      // Subtitle events have no connection flags yet.
      return false;
  }
}

function toResource(row: NotificationRow): NotificationConnection {
  const caps = capabilitiesFrom(supportedEventsFor(row.implementation, row.settings));
  const triggers = Object.fromEntries(NOTIFICATION_TRIGGERS.map((t) => [t, row[t]])) as Record<NotificationTrigger, boolean>;
  return {
    id: row.id,
    name: row.name,
    implementation: row.implementation,
    enabled: row.enabled,
    ...triggers,
    includeHealthWarnings: row.includeHealthWarnings,
    respectQuietHours: row.respectQuietHours,
    tags: row.tags,
    settings: maskSettings(row.settings),
    filters: row.filters,
    templates: row.templates,
    quietHours: row.quietHours ?? null,
    rateLimitPerMinute: row.rateLimitPerMinute,
    maxAttempts: row.maxAttempts,
    status: { consecutiveFailures: 0 },
    ...caps,
  };
}

/**
 * Templates keyed by a known event (or `default`), blank ones dropped, syntax checked.
 * Throws VALIDATION naming the template that does not parse.
 */
export function normalizeTemplates(templates: NotificationTemplates): NotificationTemplates {
  const keys = new Set<string>(TEMPLATE_KEYS);
  const out: NotificationTemplates = {};
  for (const [key, template] of Object.entries(templates)) {
    if (!keys.has(key)) throw new NotificationsError('VALIDATION', `Unknown template event "${key}"`);
    const title = template.title?.trim() ? template.title : undefined;
    const body = template.body?.trim() ? template.body : undefined;
    for (const [part, source] of [
      ['title', title],
      ['body', body],
    ] as const) {
      const problem = source === undefined ? undefined : validateTemplate(source);
      if (problem) throw new NotificationsError('VALIDATION', `Template for ${key} (${part}): ${problem}`);
    }
    if (title !== undefined || body !== undefined) {
      out[key] = { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) };
    }
  }
  return out;
}

/** What the template editor shows: `req.template` rendered against a sample event. */
export function previewTemplate(
  req: NotificationPreviewRequest,
  instanceName: string,
  now: Date,
  applicationUrl = 'https://arclight.example.com',
): NotificationPreview {
  const key = req.eventType;
  if (key !== 'default' && !(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(key)) {
    throw new NotificationsError('VALIDATION', `Unknown event type "${key}"`);
  }
  const type: NotificationEventType = key === 'default' ? 'import' : (key as NotificationEventType);
  const event = sampleEvent(type, instanceName, applicationUrl, now);
  const base = formatEvent(event);
  const template = req.template ?? {};
  const error = [template.title, template.body].map((t) => (t ? validateTemplate(t) : undefined)).find(Boolean);
  const formatted = error ? base : applyTemplate(event, base, { [type]: template });
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(templateContext(event, base))) {
    if (name === 'event' || value === undefined || value === null) continue;
    values[name] = typeof value === 'string' ? value : String(value);
  }
  return {
    subject: formatted.subject,
    title: formatted.title,
    body: formatted.body,
    ...(formatted.link ? { link: formatted.link } : {}),
    ...(formatted.posterUrl ? { posterUrl: formatted.posterUrl } : {}),
    ...(error ? { error } : {}),
    values,
  };
}

function codeOf(err: unknown): string | undefined {
  return err instanceof NotificationError ? err.code : undefined;
}


/** The stored quiet hours; off when they cannot be read (a database without the settings table). */
function readQuietHours(db: Db): QuietHoursSettings {
  try {
    return getSection(db, 'alerts').quietHours;
  } catch {
    return { enabled: false, start: '22:00', end: '07:00', days: [] };
  }
}

function notFound(id: number): NotificationsError {
  return new NotificationsError('NOT_FOUND', `Notification ${id} not found`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

