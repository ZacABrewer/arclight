import { formatEvent, type FormattedEvent } from '../format.js';
import type { FetchLike } from '../http.js';
import { applyTemplate, type MessageTemplates } from '../template.js';
import type { SmtpConnect } from '../smtp.js';
import type { SpawnLike } from './custom-script.js';
import {
  NOTIFICATION_EVENT_TYPES,
  NotificationError,
  type NotificationAgent,
  type NotificationAgentKind,
  type NotificationEvent,
  type NotificationEventType,
  type TestEvent,
} from '../types.js';

/** Injection points for tests. Production callers pass nothing and get the Node built-ins. */
export interface AgentDeps {
  fetch?: FetchLike;
  now?: () => Date;
  /** SMTP connection factory (email agent). */
  connect?: SmtpConnect;
  /** Process spawner (custom-script agent). */
  spawn?: SpawnLike;
  /** Per-event title/body templates of the destination (template.ts). */
  templates?: MessageTemplates;
  /** TCP/TLS socket factory (MQTT agent). */
  socket?: SocketConnect;
}

/** A duplex byte stream (MQTT). Tests pass an in-memory fake. */
export interface SocketLike {
  write(data: Uint8Array): void;
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  end(): void;
  destroy(): void;
}

export type SocketConnect = (options: { host: string; port: number; tls: boolean; rejectUnauthorized: boolean; timeoutMs: number }) => Promise<SocketLike>;

export const ALL_EVENTS: ReadonlySet<NotificationEventType> = new Set(NOTIFICATION_EVENT_TYPES);

/** Every event that is "a message to a human" (everything but library-maintenance signals). */
export const MESSAGE_EVENTS: ReadonlySet<NotificationEventType> = new Set(
  NOTIFICATION_EVENT_TYPES.filter((t) => t !== 'rename'),
);

/** Events after which a media server has something new to scan. */
export const LIBRARY_EVENTS: ReadonlySet<NotificationEventType> = new Set<NotificationEventType>([
  'test',
  'import',
  'upgrade',
  'rename',
  'mediaDeleted',
  'fileDeleted',
  'subtitleDownloaded',
  'fileTranscoded',
]);

export function testEvent(instanceName = 'Arclight', now: () => Date = () => new Date()): TestEvent {
  return {
    type: 'test',
    instanceName,
    timestamp: now().toISOString(),
    message: `This is a test notification from ${instanceName}.`,
  };
}

export abstract class BaseAgent implements NotificationAgent {
  abstract readonly kind: NotificationAgentKind;
  abstract readonly supportedEvents: ReadonlySet<NotificationEventType>;
  protected readonly fetch: FetchLike;
  protected readonly now: () => Date;
  protected readonly templates: MessageTemplates | undefined;

  constructor(deps: AgentDeps) {
    this.fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = deps.now ?? (() => new Date());
    this.templates = deps.templates;
  }

  /** The event as text, with the destination's template (if any) applied. Agents use this, not `formatEvent`. */
  protected format(event: NotificationEvent): FormattedEvent {
    return applyTemplate(event, formatEvent(event), this.templates);
  }

  async send(event: NotificationEvent): Promise<void> {
    if (!this.supportedEvents.has(event.type)) {
      throw new NotificationError(this.kind, 'unsupportedEvent', `${this.kind} does not handle "${event.type}" events`);
    }
    await this.deliver(event);
  }

  async test(): Promise<void> {
    await this.deliver(testEvent('Arclight', this.now));
  }

  protected abstract deliver(event: NotificationEvent): Promise<void>;
}
