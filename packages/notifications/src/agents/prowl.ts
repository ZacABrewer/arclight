/**
 * Prowl (iOS): form-encoded POST to the public API's "add" call. Prowl answers with a small
 * XML document; `<success>` means delivered and `<error code="...">` explains a refusal.
 */

import { z } from 'zod';
import { httpRequest } from '../http.js';
import { NotificationError, type NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const PROWL_URL = 'https://api.prowlapp.com/publicapi/add';

export const ProwlSettings = z.object({
  apiKey: z
    .string()
    .min(1)
    .describe('Prowl API key from prowlapp.com > API Keys. Separate several keys with commas to notify several accounts.'),
  priority: z.number().int().min(-2).max(2).default(0).describe('-2 very low, -1 moderate, 0 normal, 1 high, 2 emergency.'),
  providerKey: z.string().min(1).optional().describe('Optional provider key, only needed if you were issued one for higher rate limits.'),
});
export type ProwlSettings = z.infer<typeof ProwlSettings>;

export class ProwlAgent extends BaseAgent {
  readonly kind = 'prowl' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: ProwlSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildForm(event: NotificationEvent): Record<string, string> {
    const formatted = this.format(event);
    const keys = this.settings.apiKey
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    const form: Record<string, string> = {
      apikey: keys.join(','),
      application: event.instanceName.slice(0, 256),
      event: formatted.title.slice(0, 1024),
      description: formatted.body.slice(0, 10000),
      priority: String(this.settings.priority),
    };
    if (this.settings.providerKey) form.providerkey = this.settings.providerKey;
    if (formatted.link) form.url = formatted.link.slice(0, 512);
    return form;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    let response: Response;
    try {
      response = await httpRequest(this.fetch, this.kind, PROWL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(this.buildForm(event)).toString(),
      });
    } catch (error) {
      // The error snippet is Prowl's XML; reword it so the message reads cleanly.
      if (error instanceof NotificationError && error.status !== undefined) {
        throw new NotificationError(this.kind, error.code, `Prowl responded ${error.status}${prowlDetail(error.message)}`, { status: error.status });
      }
      throw error;
    }
    const text = await response.text().catch(() => '');
    const failure = /<error\s+code="(\d+)"[^>]*>([^<]*)<\/error>/i.exec(text);
    if (failure) {
      const code = Number(failure[1]);
      throw new NotificationError(
        this.kind,
        code === 401 ? 'unauthorized' : code === 406 ? 'rateLimited' : 'remoteError',
        `Prowl rejected the message (${code})${failure[2]!.trim() ? `: ${failure[2]!.trim()}` : ''}`,
        { status: code },
      );
    }
  }
}

function prowlDetail(message: string): string {
  const match = />([^<]+)<\/error>/i.exec(message);
  return match ? `: ${match[1]!.trim()}` : '';
}
