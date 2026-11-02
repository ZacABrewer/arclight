/**
 * Pushbullet: one push per event through the v2 REST API. A push with a link to the item
 * is sent as a "link" push so the phone opens it on tap; everything else is a "note".
 */

import { z } from 'zod';
import { httpRequest } from '../http.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const PUSHBULLET_URL = 'https://api.pushbullet.com/v2/pushes';

export const PushbulletSettings = z
  .object({
    accessToken: z.string().min(1).describe('Access token from Pushbullet Settings > Account.'),
    deviceIden: z.string().min(1).optional().describe('Send to one device (its iden). Leave blank to push to all of your devices.'),
    channelTag: z.string().min(1).optional().describe('Send to the subscribers of a channel you own, by its tag.'),
    email: z.email().optional().describe('Send to another Pushbullet user by email address.'),
  })
  .refine((s) => [s.deviceIden, s.channelTag, s.email].filter((t) => t !== undefined).length <= 1, {
    message: 'Pick at most one target: a device, a channel or an email address.',
  });
export type PushbulletSettings = z.infer<typeof PushbulletSettings>;

export interface PushbulletPayload {
  type: 'note' | 'link';
  title: string;
  body: string;
  url?: string;
  device_iden?: string;
  channel_tag?: string;
  email?: string;
}

export class PushbulletAgent extends BaseAgent {
  readonly kind = 'pushbullet' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: PushbulletSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): PushbulletPayload {
    const formatted = this.format(event);
    const payload: PushbulletPayload = formatted.link
      ? { type: 'link', title: formatted.title, body: formatted.body, url: formatted.link }
      : { type: 'note', title: formatted.title, body: formatted.body };
    if (this.settings.deviceIden) payload.device_iden = this.settings.deviceIden;
    else if (this.settings.channelTag) payload.channel_tag = this.settings.channelTag;
    else if (this.settings.email) payload.email = this.settings.email;
    return payload;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    await httpRequest(this.fetch, this.kind, PUSHBULLET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Access-Token': this.settings.accessToken },
      body: JSON.stringify(this.buildPayload(event)),
    });
  }
}
