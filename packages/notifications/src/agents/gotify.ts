import { formatEvent } from '../format.js';
import { httpRequest, joinUrl } from '../http.js';
import type { GotifySettings } from '../settings.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export interface GotifyPayload {
  title: string;
  message: string;
  priority: number;
  extras: {
    'client::display': { contentType: 'text/markdown' | 'text/plain' };
    'client::notification'?: { click: { url: string }; bigImageUrl?: string };
  };
}

export class GotifyAgent extends BaseAgent {
  readonly kind = 'gotify' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: GotifySettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): GotifyPayload {
    const formatted = formatEvent(event);
    const message = this.settings.markdown
      ? [
          `**${formatted.subject}**`,
          ...formatted.fields.map((f) => `**${f.name}:** ${f.value}`),
          ...(formatted.actions ?? []).map((a) => `[${a.label}](${a.url})`),
        ].join('  \n')
      : formatted.body;
    const payload: GotifyPayload = {
      title: formatted.title,
      message,
      priority: this.settings.priority,
      extras: { 'client::display': { contentType: this.settings.markdown ? 'text/markdown' : 'text/plain' } },
    };
    if (formatted.link) {
      payload.extras['client::notification'] = { click: { url: formatted.link } };
      if (formatted.posterUrl) payload.extras['client::notification'].bigImageUrl = formatted.posterUrl;
    }
    return payload;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    await httpRequest(this.fetch, this.kind, joinUrl(this.settings.serverUrl, 'message'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': this.settings.appToken },
      body: JSON.stringify(this.buildPayload(event)),
    });
  }
}
