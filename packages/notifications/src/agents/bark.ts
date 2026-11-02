/**
 * Bark (iOS): JSON POST to a Bark server's /push endpoint. The public server is api.day.app;
 * self-hosted bark-server instances take the same request. Bark answers `{ code: 200 }` on
 * success and its own code plus a message otherwise.
 */

import { z } from 'zod';
import { httpRequest, joinUrl, readJson } from '../http.js';
import { NotificationError, type NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const BARK_LEVELS = ['active', 'timeSensitive', 'passive', 'critical'] as const;

export const BarkSettings = z.object({
  serverUrl: z.url({ protocol: /^https?$/ }).default('https://api.day.app').describe('Bark server. Change only if you run your own bark-server.'),
  deviceKey: z.string().min(1).describe('Device key shown in the Bark app (the path segment after the server in its example URL).'),
  group: z.string().min(1).default('Arclight').describe('Group notifications under this name in Notification Center.'),
  sound: z.string().min(1).optional().describe('Bark sound name, e.g. "minuet". Leave blank for the default.'),
  level: z
    .enum(BARK_LEVELS)
    .optional()
    .describe('Interruption level: active (default), timeSensitive (breaks through Focus), passive (silent), critical (ignores mute).'),
  icon: z.url({ protocol: /^https?$/ }).optional().describe('Icon URL for every notification. Defaults to the item poster.'),
});
export type BarkSettings = z.infer<typeof BarkSettings>;

export interface BarkPayload {
  device_key: string;
  title: string;
  body: string;
  group: string;
  url?: string;
  icon?: string;
  image?: string;
  sound?: string;
  level?: (typeof BARK_LEVELS)[number];
}

interface BarkResponse {
  code?: number;
  message?: string;
}

export class BarkAgent extends BaseAgent {
  readonly kind = 'bark' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: BarkSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): BarkPayload {
    const formatted = this.format(event);
    const payload: BarkPayload = {
      device_key: this.settings.deviceKey,
      title: formatted.title,
      body: formatted.body,
      group: this.settings.group,
    };
    if (formatted.link) payload.url = formatted.link;
    const icon = this.settings.icon ?? formatted.posterUrl;
    if (icon) payload.icon = icon;
    if (formatted.posterUrl) payload.image = formatted.posterUrl;
    if (this.settings.sound) payload.sound = this.settings.sound;
    if (this.settings.level) payload.level = this.settings.level;
    return payload;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const response = await httpRequest(this.fetch, this.kind, joinUrl(this.settings.serverUrl, 'push'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(this.buildPayload(event)),
    });
    const body = await readJson<BarkResponse>(response, this.kind);
    if (body.code !== 200) {
      throw new NotificationError(this.kind, 'remoteError', `Bark rejected the message: ${body.message ?? `code ${String(body.code)}`}`);
    }
  }
}
