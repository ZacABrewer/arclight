import { type FormattedAction } from '../format.js';
import { basicAuthHeader, httpRequest } from '../http.js';
import type { WebhookSettings } from '../settings.js';
import { renderTemplate, templateContext } from '../template.js';
import { NotificationError, type NotificationEvent } from '../types.js';
import { ALL_EVENTS, BaseAgent, type AgentDeps } from './base.js';

/**
 * Without a body template the webhook body is the event itself, plus `eventType` as a friendlier alias for `type` and
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
    const actions = event.type === 'test' ? undefined : this.format(event).actions;
    return { eventType: event.type, ...event, ...(actions ? { actions } : {}) };
  }

  /**
   * The request body: the JSON event, or the user's body template rendered with every plain
   * variable JSON-escaped. A JSON content type must still produce valid JSON.
   */
  buildBody(event: NotificationEvent): string {
    const template = this.settings.bodyTemplate?.trim();
    if (!template) return JSON.stringify(this.buildPayload(event));
    const formatted = this.format(event);
    const json = /json/i.test(this.settings.contentType);
    const body = renderTemplate(template, templateContext(event, formatted), json ? 'json' : 'none');
    if (json) {
      try {
        JSON.parse(body);
      } catch {
        throw new NotificationError(this.kind, 'invalidSettings', 'The body template did not produce valid JSON');
      }
    }
    return body;
  }

  buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.settings.headers,
      'Content-Type': this.settings.bodyTemplate?.trim() ? this.settings.contentType : 'application/json',
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
      body: this.buildBody(event),
    });
  }
}
