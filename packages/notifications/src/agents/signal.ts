/**
 * Signal via a self-hosted signal-cli-rest-api server. Sends styled text (bold headline) to
 * numbers and groups, with the poster attached as an image when it can be fetched.
 */

import { z } from 'zod';
import type { FormattedAction, FormattedEvent } from '../format.js';
import { basicAuthHeader, httpRequest, joinUrl } from '../http.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

const E164 = /^\+[1-9]\d{6,14}$/;
const GROUP_ID = /^group\.[A-Za-z0-9+/=_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SignalSettings = z
  .object({
    serverUrl: z.url({ protocol: /^https?$/ }).describe('Base URL of your signal-cli-rest-api server, e.g. http://signal-api:8080.'),
    number: z.string().regex(E164, 'Use the international format, e.g. +15550100').describe('The registered (or linked) sender number, in international format.'),
    recipients: z
      .array(
        z
          .string()
          .refine((r) => E164.test(r) || GROUP_ID.test(r) || UUID.test(r), 'Use +<number>, a group id (group.…) or an account UUID'),
      )
      .min(1)
      .describe('Phone numbers (+15550100), group ids (group.…, from GET /v1/groups/<number>) or account UUIDs to message.'),
    username: z.string().optional().describe('HTTP basic auth username, if the server sits behind a proxy that requires it.'),
    password: z.string().optional().describe('HTTP basic auth password.'),
    attachPoster: z.boolean().default(true).describe('Attach the poster image to the message.'),
  })
  .refine((s) => (s.username === undefined) === (s.password === undefined), {
    message: 'Set both username and password, or neither',
    path: ['password'],
  });
export type SignalSettings = z.infer<typeof SignalSettings>;

const MESSAGE_MAX = 4000;
export const POSTER_MAX_BYTES = 5 * 1024 * 1024;
const POSTER_TIMEOUT_MS = 10_000;

export interface SignalPayload {
  message: string;
  number: string;
  recipients: string[];
  text_mode: 'styled';
  base64_attachments?: string[];
}

export class SignalAgent extends BaseAgent {
  readonly kind = 'signal' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: SignalSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  /** The message without the poster (attached at delivery, since it has to be downloaded). */
  buildPayload(event: NotificationEvent): SignalPayload {
    const formatted = this.format(event);
    // Styled mode: **bold**. The headline is stripped of asterisks so it cannot break the markup.
    const out = [`**${formatted.title.replace(/\*/g, '')}**`];
    if (formatted.templated?.body) {
      out.push(formatted.body);
    } else {
      out.push(formatted.subject);
      for (const field of formatted.fields.filter((f) => f.value.length > 0)) out.push(`${field.name}: ${field.value}`);
    }
    if (formatted.person) out.push(`Requested by ${formatted.person.name}`);
    const links = linkList(formatted);
    if (links.length > 0) out.push('', ...links.map((l) => `${l.label}: ${l.url}`));

    return {
      message: clip(out.join('\n'), MESSAGE_MAX),
      number: this.settings.number,
      recipients: [...this.settings.recipients],
      text_mode: 'styled',
    };
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const payload = this.buildPayload(event);
    if (this.settings.attachPoster) {
      const posterUrl = this.format(event).posterUrl;
      const attachment = posterUrl ? await this.fetchPoster(posterUrl) : undefined;
      if (attachment) payload.base64_attachments = [attachment];
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.settings.username !== undefined && this.settings.password !== undefined) {
      headers.Authorization = basicAuthHeader(this.settings.username, this.settings.password);
    }
    await httpRequest(this.fetch, this.kind, joinUrl(this.settings.serverUrl, '/v2/send'), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  }

  /** The poster as a data URI attachment, or undefined if it is missing, too big or not an image. */
  private async fetchPoster(url: string): Promise<string | undefined> {
    try {
      const response = await httpRequest(this.fetch, this.kind, url, { timeoutMs: POSTER_TIMEOUT_MS });
      const mime = (response.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim().toLowerCase();
      if (!mime.startsWith('image/')) return undefined;
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > POSTER_MAX_BYTES) return undefined;
      const bytes = await readCapped(response, POSTER_MAX_BYTES);
      if (!bytes || bytes.length === 0) return undefined;
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
      return `data:${mime};filename=poster.${ext};base64,${bytes.toString('base64')}`;
    } catch {
      return undefined; // A missing poster never blocks the message.
    }
  }
}

/** The body, or undefined as soon as it grows past `max` bytes (the rest is never downloaded). */
async function readCapped(response: Response, max: number): Promise<Buffer | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The event's actions first (approve/decline), then the item link unless an action already opens it. */
function linkList(formatted: FormattedEvent): FormattedAction[] {
  const out: FormattedAction[] = [...(formatted.actions ?? [])];
  if (formatted.link && !out.some((a) => a.url === formatted.link)) out.push({ label: 'Open', url: formatted.link });
  return out;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
