import { asc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  createAgent,
  NotificationError,
  parseAgentSettings,
  testEvent,
  type NotificationAgent,
  type NotificationAgentKind,
  type NotificationEvent,
} from '@media-tron/notifications';
import {
  NOTIFICATION_TRIGGERS,
  NotificationInput,
  NotificationTestRequest,
  type NotificationConnection,
  type NotificationInputRaw,
  type NotificationSchema,
  type NotificationTestAllResult,
  type NotificationTestResult,
  type NotificationTrigger,
} from '@media-tron/shared';
import type { Db } from '../../db/index.js';
import { tags as tagsTable } from '../../db/schema.js';
import { allSchemas, capabilitiesFrom, maskSettings, supportedEventsFor, TRIGGER_EVENT, unmaskSettings } from './fields.js';
import { notifications, type NotificationRow } from './schema.js';

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

/** Builds an agent from validated settings. Injected in tests. */
export type AgentFactory = (kind: NotificationAgentKind, settings: unknown) => NotificationAgent;

export interface NotificationsServiceOptions {
  db: Db;
  log?: Logger;
  agentFactory?: AgentFactory;
  now?: () => Date;
  instanceName?: string;
}

export interface DispatchOutcome {
  id: number;
  name: string;
  ok: boolean;
  error?: string;
}

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

  constructor(options: NotificationsServiceOptions) {
    this.db = options.db;
    this.log = options.log;
    this.factory = options.agentFactory ?? ((kind, settings) => createAgent(kind, settings));
    this.now = options.now ?? (() => new Date());
    this.instanceName = options.instanceName ?? 'Media-Tron';
  }

  // ---- CRUD ------------------------------------------------------------------------------

  list(): NotificationConnection[] {
    return this.rows().map(toResource);
  }

  get(id: number): NotificationConnection {
    return toResource(this.requireRow(id));
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
    return toResource(row);
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
    return toResource(row);
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
    return this.sendTest(values.implementation, values.settings);
  }

  async testAll(): Promise<NotificationTestAllResult> {
    const results: NotificationTestAllResult = [];
    for (const row of this.rows().filter((r) => r.enabled)) {
      const result = await this.sendTest(row.implementation, row.settings);
      this.record(row.id, result.ok ? undefined : (result.message ?? 'test failed'));
      results.push({ id: row.id, name: row.name, ...result });
    }
    return results;
  }

  private async sendTest(kind: NotificationAgentKind, settings: unknown): Promise<NotificationTestResult> {
    try {
      const agent = this.factory(kind, settings);
      await agent.send(testEvent(this.instanceName, this.now));
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof NotificationError ? { code: err.code } : {}),
      };
    }
  }

  // ---- dispatch ------------------------------------------------------------------------------

  /**
   * Deliver `event` to every enabled connection whose trigger flags, health-warning option,
   * tags and agent capabilities accept it. One failing connection never affects the others;
   * failures are logged and recorded per connection. Resolves once every send settled.
   */
  async dispatch(event: NotificationEvent): Promise<DispatchOutcome[]> {
    const rows = this.rows().filter((r) => r.enabled && wantsEvent(r, event));
    if (rows.length === 0) return [];
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
        let agent: NotificationAgent;
        try {
          agent = this.factory(row.implementation, row.settings);
        } catch (err) {
          const message = errorMessage(err);
          this.log?.warn({ err, notification: row.name }, 'notification connection is misconfigured');
          this.record(row.id, message);
          return { id: row.id, name: row.name, ok: false, error: message };
        }
        if (!agent.supportedEvents.has(event.type)) return null;
        try {
          await agent.send(event);
          this.record(row.id, undefined);
          return { id: row.id, name: row.name, ok: true };
        } catch (err) {
          const message = errorMessage(err);
          this.log?.warn({ err, notification: row.name, event: event.type }, 'notification failed');
          this.record(row.id, message);
          return { id: row.id, name: row.name, ok: false, error: message };
        }
      }),
    );
    return outcomes.filter((o): o is DispatchOutcome => o !== null);
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
      tags: [...new Set(input.tags)],
      settings,
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
    default:
      // Subtitle and request events have no connection flags yet.
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
    tags: row.tags,
    settings: maskSettings(row.settings),
    ...caps,
  };
}

function notFound(id: number): NotificationsError {
  return new NotificationsError('NOT_FOUND', `Notification ${id} not found`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

