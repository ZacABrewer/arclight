/**
 * Rocket.Chat via an incoming webhook integration. One attachment carries the linked title,
 * colour, fields and the poster; the deep links go into the text as Markdown links.
 */

import { z } from 'zod';
import type { FormattedAction, FormattedEvent, Severity } from '../format.js';
import { httpRequest } from '../http.js';
import { NotificationError, type NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const RocketChatSettings = z.object({
  webhookUrl: z
    .url({ protocol: /^https?$/ })
    .describe('Incoming webhook URL (Administration > Workspace > Integrations > New > Incoming), including its token.'),
  channel: z.string().max(100).optional().describe('Override the channel (#channel) or user (@user). Leave blank for the integration default.'),
  alias: z.string().max(100).optional().describe('Display name shown instead of the integration user.'),
  avatarUrl: z.url({ protocol: /^https?$/ }).optional().describe('Avatar image URL for the message.'),
  emoji: z
    .string()
    .regex(/^:[\w+-]+:$/, 'Use the :emoji_name: form')
    .optional()
    .describe('Emoji avatar, e.g. :clapper:. Ignored when an avatar URL is set.'),
  largePoster: z.boolean().default(false).describe('Show the poster as a large image instead of a thumbnail.'),
});
export type RocketChatSettings = z.infer<typeof RocketChatSettings>;

export const ROCKETCHAT_COLOURS: Record<Severity, string> = {
  info: '#00c8ff',
  success: '#2ecc71',
  upgrade: '#8e44ad',
  warning: '#f39c12',
  error: '#e74c3c',
};

const TEXT_MAX = 5000;
const FIELD_VALUE_MAX = 1000;
const MAX_FIELDS = 20;

export interface RocketChatAttachment {
  title: string;
  title_link?: string;
  text: string;
  color: string;
  image_url?: string;
  thumb_url?: string;
  author_name?: string;
  author_icon?: string;
  fields: Array<{ short: boolean; title: string; value: string }>;
}

export interface RocketChatPayload {
  text: string;
  channel?: string;
  alias?: string;
  avatar?: string;
  emoji?: string;
  attachments: RocketChatAttachment[];
}

export class RocketChatAgent extends BaseAgent {
  readonly kind = 'rocketchat' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: RocketChatSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): RocketChatPayload {
    const formatted = this.format(event);
    const lines: string[] = [];
    if (formatted.templated?.body) lines.push(formatted.body);
    const links = linkList(formatted);
    if (links.length > 0) lines.push(links.map((l) => `[${l.label.replace(/[[\]]/g, '')}](${l.url})`).join(' · '));

    const attachment: RocketChatAttachment = {
      title: clip(formatted.title, 250),
      text: clip(lines.join('\n\n'), TEXT_MAX),
      color: ROCKETCHAT_COLOURS[formatted.severity],
      fields: formatted.fields
        .filter((f) => f.value.length > 0)
        .slice(0, MAX_FIELDS)
        .map((f) => ({ short: f.inline ?? false, title: f.name, value: clip(f.value, FIELD_VALUE_MAX) })),
    };
    if (formatted.link) attachment.title_link = formatted.link;
    if (formatted.posterUrl) {
      if (this.settings.largePoster) attachment.image_url = formatted.posterUrl;
      else attachment.thumb_url = formatted.posterUrl;
    }
    if (formatted.person) {
      attachment.author_name = `Requested by ${formatted.person.name}`;
      if (formatted.person.avatarUrl && /^https?:\/\//.test(formatted.person.avatarUrl)) attachment.author_icon = formatted.person.avatarUrl;
    }

    // The message line above the attachment: what happened, on which instance.
    const payload: RocketChatPayload = { text: clip(`*${formatted.subject}* · ${event.instanceName}`, 500), attachments: [attachment] };
    if (this.settings.channel) payload.channel = this.settings.channel;
    if (this.settings.alias) payload.alias = this.settings.alias;
    if (this.settings.avatarUrl) payload.avatar = this.settings.avatarUrl;
    else if (this.settings.emoji) payload.emoji = this.settings.emoji;
    return payload;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const response = await httpRequest(this.fetch, this.kind, this.settings.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildPayload(event)),
      label: 'Rocket.Chat webhook',
    });
    // Rocket.Chat answers `{ success: false, error }` when the integration script rejects the message.
    const text = await response.text().catch(() => '');
    let result: { success?: unknown; error?: unknown } | undefined;
    try {
      result = text ? (JSON.parse(text) as typeof result) : undefined;
    } catch {
      result = undefined;
    }
    if (result?.success === false) {
      const detail = typeof result.error === 'string' ? `: ${result.error.slice(0, 200)}` : '';
      throw new NotificationError(this.kind, 'remoteError', `Rocket.Chat webhook rejected the message${detail}`);
    }
  }
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
