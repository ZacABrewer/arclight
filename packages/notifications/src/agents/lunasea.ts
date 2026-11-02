/**
 * LunaSea: the app's "custom notification" webhook. LunaSea shows a per-user or per-device
 * URL that accepts a JSON `{ title, body, image }`; the id in the path is the secret.
 */

import { z } from 'zod';
import { httpRequest } from '../http.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

const CUSTOM_PATH = /\/custom\/(user|device)\/[^/]+\/?$/;

export const LunaSeaSettings = z.object({
  webhookUrl: z
    .url({ protocol: /^https?$/ })
    .refine((u) => CUSTOM_PATH.test(new URL(u).pathname), 'Use the custom notification URL from LunaSea (…/v1/custom/user/<id> or …/v1/custom/device/<id>)')
    .describe('Custom notification URL from LunaSea > Settings > Notifications, e.g. https://notify.lunasea.app/v1/custom/user/<id>.'),
});
export type LunaSeaSettings = z.infer<typeof LunaSeaSettings>;

export interface LunaSeaPayload {
  title: string;
  body: string;
  image?: string;
}

export class LunaSeaAgent extends BaseAgent {
  readonly kind = 'lunasea' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: LunaSeaSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): LunaSeaPayload {
    const formatted = this.format(event);
    const payload: LunaSeaPayload = { title: formatted.title, body: formatted.body };
    if (formatted.posterUrl) payload.image = formatted.posterUrl;
    return payload;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    await httpRequest(this.fetch, this.kind, this.settings.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildPayload(event)),
      label: 'LunaSea',
    });
  }
}
