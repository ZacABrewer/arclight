/**
 * Notifiarr "passthrough": Notifiarr relays a Discord embed we describe to a channel its bot can
 * post in. The channel id is a Discord snowflake, which is larger than a JS number can hold
 * exactly, so the request body writes it as a raw JSON integer from the original digits.
 */

import { z } from 'zod';
import type { Severity } from '../format.js';
import { httpRequest } from '../http.js';
import { NotificationError, type NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const NOTIFIARR_PASSTHROUGH_URL = 'https://notifiarr.com/api/v1/notification/passthrough';

export const NotifiarrSettings = z.object({
  apiKey: z.string().min(1).describe('Notifiarr API key (Profile > API Keys) with the passthrough integration enabled.'),
  channelId: z
    .string()
    .regex(/^\d{5,20}$/, 'A Discord channel id is a number, e.g. 735481457153277994')
    .describe('Discord channel id to post in (enable Developer Mode, right-click the channel, Copy Channel ID).'),
  color: z
    .string()
    .regex(/^#?[0-9A-Fa-f]{6}$/, 'A six-digit hex colour, e.g. #3fa9f5')
    .optional()
    .describe('Embed colour override. Leave blank to colour by severity.'),
});
export type NotifiarrSettings = z.infer<typeof NotifiarrSettings>;

export const SEVERITY_COLORS: Record<Severity, string> = {
  info: '3FA9F5',
  success: '2ECC71',
  upgrade: '9B59B6',
  warning: 'F1C40F',
  error: 'E74C3C',
};

export interface NotifiarrPayload {
  notification: { update: false; name: string; event: string };
  discord: {
    color: string;
    ping: { pingUser: 0; pingRole: 0 };
    images: { thumbnail: string; image: string };
    text: {
      title: string;
      icon: string;
      content: string;
      description: string;
      fields: Array<{ title: string; text: string; inline: boolean }>;
      footer: string;
    };
    /** Number(channelId): may be imprecise for real snowflakes. `buildBody` sends the exact digits. */
    ids: { channel: number };
  };
}

const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const CHANNEL_PLACEHOLDER = '"__ARCLIGHT_CHANNEL_ID__"';

export class NotifiarrAgent extends BaseAgent {
  readonly kind = 'notifiarr' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: NotifiarrSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): NotifiarrPayload {
    const formatted = this.format(event);
    const color = (this.settings.color?.replace(/^#/, '') ?? SEVERITY_COLORS[formatted.severity]).toUpperCase();
    return {
      notification: { update: false, name: event.instanceName, event: event.type },
      discord: {
        color,
        ping: { pingUser: 0, pingRole: 0 },
        images: { thumbnail: formatted.posterUrl ?? '', image: '' },
        text: {
          // Discord embed limits: title 256, description 4096, 25 fields of 256/1024.
          title: truncate(formatted.title, 256),
          icon: '',
          content: '',
          description: truncate(formatted.body, 4096),
          fields: formatted.fields.slice(0, 25).map((f) => ({
            title: truncate(f.name, 256),
            text: truncate(f.value, 1024),
            inline: f.inline ?? false,
          })),
          footer: event.instanceName,
        },
        ids: { channel: Number(this.settings.channelId) },
      },
    };
  }

  /** The JSON sent on the wire, with the channel id as an exact integer literal. */
  buildBody(event: NotificationEvent): string {
    const payload = this.buildPayload(event);
    const json = JSON.stringify({ ...payload, discord: { ...payload.discord, ids: { channel: '__ARCLIGHT_CHANNEL_ID__' } } });
    return json.replace(CHANNEL_PLACEHOLDER, this.settings.channelId);
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const response = await httpRequest(this.fetch, this.kind, NOTIFIARR_PASSTHROUGH_URL, {
      method: 'POST',
      headers: { 'X-API-Key': this.settings.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: this.buildBody(event),
    });
    // Notifiarr can answer 200 with `{ result: "error", ... }`; anything unparsable counts as accepted.
    const text = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed && typeof parsed === 'object' && (parsed as { result?: unknown }).result === 'error') {
      const details = (parsed as { details?: { response?: unknown; message?: unknown } }).details;
      const reason = typeof details?.response === 'string' ? details.response : typeof details?.message === 'string' ? details.message : 'request rejected';
      throw new NotificationError(this.kind, 'remoteError', `Notifiarr rejected the notification: ${truncate(reason, 200)}`);
    }
  }
}
