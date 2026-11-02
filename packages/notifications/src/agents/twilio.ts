/**
 * Twilio: SMS (or WhatsApp through Twilio's WhatsApp API) via the REST Messages resource.
 * One request per recipient; every recipient is attempted and failures are reported together.
 */

import { z } from 'zod';
import { basicAuthHeader, httpRequest } from '../http.js';
import { NotificationError, type NotificationErrorCode, type NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

const E164 = /^\+[1-9]\d{1,14}$/;

/** Twilio's limit for a single (concatenated) message body. */
export const TWILIO_BODY_LIMIT = 1600;

export const TwilioSettings = z.object({
  accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/, 'Account SID starts with "AC"').describe('Account SID from the Twilio console (starts with "AC").'),
  authToken: z.string().min(1).describe('Auth token from the Twilio console.'),
  from: z
    .string()
    .refine((v) => E164.test(v) || /^MG[0-9a-fA-F]{32}$/.test(v), 'Use an E.164 number like +15550100 or a Messaging Service SID (MG...)')
    .describe('Sending number in E.164 form (+15550100) or a Messaging Service SID (starts with "MG").'),
  to: z.array(z.string().regex(E164, 'Use E.164 form, e.g. +15550100')).min(1).describe('Recipient numbers in E.164 form.'),
  channel: z.enum(['sms', 'whatsapp']).default('sms').describe('SMS, or WhatsApp through Twilio (sender must be WhatsApp-enabled).'),
  includeLink: z.boolean().default(true).describe('Append a link to the item.'),
  attachPoster: z.boolean().default(false).describe('Attach the poster image (MMS or WhatsApp only; US/Canada numbers for MMS).'),
});
export type TwilioSettings = z.infer<typeof TwilioSettings>;

export class TwilioAgent extends BaseAgent {
  readonly kind = 'twilio' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: TwilioSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  /** One form per recipient, as maps so tests can read them. */
  buildForms(event: NotificationEvent): Array<Record<string, string>> {
    const formatted = this.format(event);
    // The default body ends with the link / action lines; rebuild it so they can be dropped
    // (includeLink off) and so clipping never cuts a URL in half.
    const core = formatted.templated?.body
      ? formatted.body
      : [formatted.subject, ...formatted.fields.map((f) => `${f.name}: ${f.value}`)].join('\n');
    const links = !this.settings.includeLink
      ? []
      : formatted.actions && formatted.actions.length > 0
        ? formatted.actions.map((a) => `${a.label}: ${a.url}`)
        : formatted.link
          ? [formatted.link]
          : [];
    const tail = links.join('\n');
    const text = [formatted.title, core].filter((p) => p.length > 0).join('\n');
    const body = tail ? `${clip(text, TWILIO_BODY_LIMIT - tail.length - 1)}\n${tail}` : clip(text, TWILIO_BODY_LIMIT);
    const address = (n: string) => (this.settings.channel === 'whatsapp' ? `whatsapp:${n}` : n);
    return this.settings.to.map((to) => {
      const form: Record<string, string> = { To: address(to) };
      if (this.settings.from.startsWith('MG')) form.MessagingServiceSid = this.settings.from;
      else form.From = address(this.settings.from);
      form.Body = body;
      if (this.settings.attachPoster && formatted.posterUrl) form.MediaUrl = formatted.posterUrl;
      return form;
    });
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.settings.accountSid)}/Messages.json`;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(this.settings.accountSid, this.settings.authToken),
    };
    const failures: Array<{ to: string; error: NotificationError }> = [];
    for (const form of this.buildForms(event)) {
      try {
        await httpRequest(this.fetch, this.kind, url, {
          method: 'POST',
          headers,
          body: new URLSearchParams(form).toString(),
          label: 'Twilio API',
        });
      } catch (error) {
        if (!(error instanceof NotificationError)) throw error;
        failures.push({ to: form.To!, error });
      }
    }
    if (failures.length === 0) return;
    // One error for the whole send: a shared code when every failure agrees, else remoteError.
    const codes = new Set(failures.map((f) => f.error.code));
    const code: NotificationErrorCode = codes.size === 1 ? failures[0]!.error.code : 'remoteError';
    const status = failures.length === 1 ? failures[0]!.error.status : undefined;
    const summary = failures.map((f) => `${f.to}: ${f.error.message}`).join('; ');
    throw new NotificationError(
      this.kind,
      code,
      `Twilio failed for ${failures.length} of ${this.settings.to.length} recipient(s): ${summary}`,
      status === undefined ? {} : { status },
    );
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
