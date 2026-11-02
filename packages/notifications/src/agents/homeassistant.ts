/**
 * Home Assistant over its REST API with a long-lived access token. "notify" calls a notify
 * service (a Companion app phone, a group, ...); "event" fires an event on the HA event bus
 * for automations to trigger on; "both" does each.
 */

import { z } from 'zod';
import { httpRequest, joinUrl } from '../http.js';
import type { Severity } from '../format.js';
import type { NotificationEvent, NotificationEventType } from '../types.js';
import { ALL_EVENTS, BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const HomeAssistantSettings = z.object({
  baseUrl: z.url({ protocol: /^https?$/ }).describe('Home Assistant URL, e.g. http://homeassistant.local:8123.'),
  accessToken: z.string().min(1).describe('Long-lived access token (your HA profile > Security).'),
  mode: z
    .enum(['notify', 'event', 'both'])
    .default('notify')
    .describe('notify = call a notify service, event = fire an event for automations, both = each.'),
  notifyService: z
    .string()
    .regex(/^(notify\.)?[a-z0-9_]+$/, 'Lowercase letters, digits and underscores only')
    .default('notify')
    .describe('Notify service name: the part after "notify.", e.g. mobile_app_pixel. "notify" uses the default.'),
  eventType: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+$/, 'Letters, digits, ".", "-" and "_" only')
    .default('arclight_event')
    .describe('Event type fired on the HA event bus (event mode).'),
});
export type HomeAssistantSettings = z.infer<typeof HomeAssistantSettings>;

export interface HomeAssistantNotifyPayload {
  title: string;
  message: string;
  data: {
    url?: string;
    clickAction?: string;
    image?: string;
    actions?: Array<{ action: 'URI'; title: string; uri: string }>;
  };
}

export type HomeAssistantEventPayload = Record<string, unknown> & {
  eventType: NotificationEventType;
  title: string;
  body: string;
  severity: Severity;
  link?: string;
  posterUrl?: string;
};

export interface HomeAssistantRequest {
  url: string;
  body: HomeAssistantNotifyPayload | HomeAssistantEventPayload;
}

export class HomeAssistantAgent extends BaseAgent {
  readonly kind = 'homeassistant' as const;
  readonly supportedEvents: ReadonlySet<NotificationEventType>;

  constructor(
    private readonly settings: HomeAssistantSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
    this.supportedEvents = settings.mode === 'notify' ? MESSAGE_EVENTS : ALL_EVENTS;
  }

  buildNotifyPayload(event: NotificationEvent): HomeAssistantNotifyPayload {
    const formatted = this.format(event);
    const data: HomeAssistantNotifyPayload['data'] = {};
    if (formatted.link) {
      data.url = formatted.link; // iOS Companion app
      data.clickAction = formatted.link; // Android Companion app
    }
    if (formatted.posterUrl) data.image = formatted.posterUrl;
    if (formatted.actions && formatted.actions.length > 0) {
      // The Companion apps show at most three action buttons.
      data.actions = formatted.actions.slice(0, 3).map((a) => ({ action: 'URI', title: a.label, uri: a.url }));
    }
    return { title: formatted.title, message: formatted.body, data };
  }

  buildEventPayload(event: NotificationEvent): HomeAssistantEventPayload {
    const formatted = this.format(event);
    return {
      ...event,
      eventType: event.type,
      title: formatted.title,
      body: formatted.body,
      severity: formatted.severity,
      ...(formatted.link ? { link: formatted.link } : {}),
      ...(formatted.posterUrl ? { posterUrl: formatted.posterUrl } : {}),
    };
  }

  /** The requests one event turns into, in send order. */
  buildPayload(event: NotificationEvent): HomeAssistantRequest[] {
    const requests: HomeAssistantRequest[] = [];
    const notify = this.settings.mode === 'notify' || (this.settings.mode === 'both' && MESSAGE_EVENTS.has(event.type));
    if (notify) {
      const service = this.settings.notifyService.replace(/^notify\./, '');
      requests.push({ url: joinUrl(this.settings.baseUrl, `api/services/notify/${service}`), body: this.buildNotifyPayload(event) });
    }
    if (this.settings.mode !== 'notify') {
      requests.push({
        url: joinUrl(this.settings.baseUrl, `api/events/${encodeURIComponent(this.settings.eventType)}`),
        body: this.buildEventPayload(event),
      });
    }
    return requests;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    for (const request of this.buildPayload(event)) {
      await httpRequest(this.fetch, this.kind, request.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.settings.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
    }
  }
}
