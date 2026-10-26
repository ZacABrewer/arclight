import type { FetchLike } from '../http.js';
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
}

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
]);

export function testEvent(instanceName = 'Media-Tron', now: () => Date = () => new Date()): TestEvent {
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

  constructor(deps: AgentDeps) {
    this.fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = deps.now ?? (() => new Date());
  }

  async send(event: NotificationEvent): Promise<void> {
    if (!this.supportedEvents.has(event.type)) {
      throw new NotificationError(this.kind, 'unsupportedEvent', `${this.kind} does not handle "${event.type}" events`);
    }
    await this.deliver(event);
  }

  async test(): Promise<void> {
    await this.deliver(testEvent('Media-Tron', this.now));
  }

  protected abstract deliver(event: NotificationEvent): Promise<void>;
}
