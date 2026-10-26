import { formatEvent } from '../format.js';
import { httpRequest } from '../http.js';
import type { PushoverSettings } from '../settings.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

export class PushoverAgent extends BaseAgent {
  readonly kind = 'pushover' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: PushoverSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  /** Pushover takes form-encoded fields; returned as a map so tests can read it. */
  buildForm(event: NotificationEvent): Record<string, string> {
    const formatted = formatEvent(event);
    const form: Record<string, string> = {
      token: this.settings.apiToken,
      user: this.settings.userKey,
      title: formatted.title.slice(0, 250),
      message: formatted.body.slice(0, 1024),
      priority: String(this.settings.priority),
      timestamp: String(Math.floor(Date.parse(event.timestamp) / 1000)),
    };
    if (this.settings.devices.length > 0) form.device = this.settings.devices.join(',');
    if (this.settings.priority === 2) {
      form.retry = String(this.settings.retry);
      form.expire = String(this.settings.expire);
    }
    if (this.settings.sound) form.sound = this.settings.sound;
    if (formatted.link) {
      form.url = formatted.link;
      form.url_title = 'Open in Arclight';
    }
    return form;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    await httpRequest(this.fetch, this.kind, PUSHOVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(this.buildForm(event)).toString(),
    });
  }
}
