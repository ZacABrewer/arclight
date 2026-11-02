/**
 * SimplePush: form-encoded POST to /send with the user's key. Messages go unencrypted;
 * SimplePush's optional end-to-end encryption is out of scope for this agent.
 */

import { z } from 'zod';
import { httpRequest, readJson } from '../http.js';
import { NotificationError, type NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const SIMPLEPUSH_URL = 'https://api.simplepush.io/send';

export const SimplePushSettings = z
  .object({
    apiKey: z.string().min(1).describe('Your SimplePush key, shown in the SimplePush app.'),
    event: z.string().min(1).optional().describe('Event name, so the app can give Arclight its own ringtone and vibration pattern.'),
  })
  .describe('SimplePush. Messages are sent without end-to-end encryption, which this agent does not support.');
export type SimplePushSettings = z.infer<typeof SimplePushSettings>;

interface SimplePushResponse {
  status?: string;
  message?: string;
}

export class SimplePushAgent extends BaseAgent {
  readonly kind = 'simplepush' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: SimplePushSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildForm(event: NotificationEvent): Record<string, string> {
    const formatted = this.format(event);
    // The API has no link field; the default body already ends with the link, a template may not.
    const msg = formatted.link && !formatted.body.includes(formatted.link) ? `${formatted.body}\n${formatted.link}` : formatted.body;
    const form: Record<string, string> = { key: this.settings.apiKey, title: formatted.title, msg };
    if (this.settings.event) form.event = this.settings.event;
    return form;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const response = await httpRequest(this.fetch, this.kind, SIMPLEPUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(this.buildForm(event)).toString(),
    });
    const body = await readJson<SimplePushResponse>(response, this.kind);
    if (body.status !== 'OK') {
      throw new NotificationError(this.kind, 'remoteError', `SimplePush rejected the message: ${body.message ?? body.status ?? 'unknown error'}`);
    }
  }
}
