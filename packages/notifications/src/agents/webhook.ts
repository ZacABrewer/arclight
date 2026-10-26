import { formatEvent, type FormattedAction } from '../format.js';
import { basicAuthHeader, httpRequest } from '../http.js';
import type { WebhookSettings } from '../settings.js';
import type { NotificationEvent } from '../types.js';
import { ALL_EVENTS, BaseAgent, type AgentDeps } from './base.js';

/**
 * The webhook body is the event itself, plus `eventType` as a friendlier alias for `type` and
 * `actions` (approve/decline deep links) when the event has any.
 */
export type WebhookPayload = NotificationEvent & { eventType: NotificationEvent['type']; actions?: FormattedAction[] };

export class WebhookAgent extends BaseAgent {
  readonly kind = 'webhook' as const;
  readonly supportedEvents = ALL_EVENTS;

  constructor(
    private readonly settings: WebhookSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): WebhookPayload {
    const actions = event.type === 'test' ? undefined : formatEvent(event).actions;
    return { eventType: event.type, ...event, ...(actions ? { actions } : {}) };
  }

  buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.settings.headers,
      'Content-Type': 'application/json',
    };
    if (this.settings.username && this.settings.password !== undefined) {
      headers.Authorization = basicAuthHeader(this.settings.username, this.settings.password);
    }
    return headers;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    await httpRequest(this.fetch, this.kind, this.settings.url, {
      method: this.settings.method,
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildPayload(event)),
    });
  }
}
