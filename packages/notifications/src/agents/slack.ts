/**
 * Slack via an Incoming Webhook. The message is Block Kit: a headline section with the poster
 * beside it, the event fields in a two-column fields section, a context line, and link buttons.
 */

import { z } from 'zod';
import type { FormattedAction, FormattedEvent } from '../format.js';
import { httpRequest } from '../http.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const SlackSettings = z.object({
  webhookUrl: z.url({ protocol: /^https?$/ }).describe('Slack Incoming Webhook URL (Slack app > Incoming Webhooks > Add New Webhook).'),
  channel: z.string().max(80).optional().describe('Override the channel, e.g. #media. Only legacy webhooks honour this; app webhooks always post to their own channel.'),
  username: z.string().max(80).optional().describe('Override the sender name (legacy webhooks only).'),
  iconUrl: z.url({ protocol: /^https?$/ }).optional().describe('Override the sender icon with an image URL (legacy webhooks only).'),
  iconEmoji: z
    .string()
    .regex(/^:[\w+-]+:$/, 'Use the :emoji_name: form')
    .optional()
    .describe('Override the sender icon with an emoji, e.g. :clapper: (legacy webhooks only). Ignored when an icon URL is set.'),
});
export type SlackSettings = z.infer<typeof SlackSettings>;

/** Block Kit limits (api.slack.com/reference/block-kit). */
const SECTION_TEXT_MAX = 3000;
const FIELD_TEXT_MAX = 2000;
const MAX_FIELDS = 10;
const BUTTON_TEXT_MAX = 75;
const MAX_BUTTONS = 5;

export type SlackText = { type: 'mrkdwn'; text: string } | { type: 'plain_text'; text: string; emoji?: boolean };

export type SlackBlock =
  | { type: 'section'; text?: SlackText; fields?: SlackText[]; accessory?: { type: 'image'; image_url: string; alt_text: string } }
  | { type: 'context'; elements: SlackText[] }
  | {
      type: 'actions';
      elements: Array<{ type: 'button'; text: SlackText; url: string; action_id: string; style?: 'primary' | 'danger' }>;
    };

export interface SlackPayload {
  text: string;
  blocks: SlackBlock[];
  channel?: string;
  username?: string;
  icon_url?: string;
  icon_emoji?: string;
}

export class SlackAgent extends BaseAgent {
  readonly kind = 'slack' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: SlackSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): SlackPayload {
    const formatted = this.format(event);
    const templatedBody = formatted.templated?.body === true;
    const title = escapeMrkdwn(formatted.title);
    const headline = formatted.link ? `*<${formatted.link}|${title}>*` : `*${title}*`;
    const text = escapeMrkdwn(templatedBody ? formatted.body : formatted.subject);

    const headlineBlock: SlackBlock = { type: 'section', text: { type: 'mrkdwn', text: clip(`${headline}\n${text}`, SECTION_TEXT_MAX) } };
    if (formatted.posterUrl) headlineBlock.accessory = { type: 'image', image_url: formatted.posterUrl, alt_text: clip(formatted.title, 200) };
    const blocks: SlackBlock[] = [headlineBlock];

    const fields = formatted.fields
      .filter((f) => f.value.length > 0)
      .slice(0, MAX_FIELDS)
      .map((f): SlackText => ({ type: 'mrkdwn', text: clip(`*${escapeMrkdwn(f.name)}*\n${escapeMrkdwn(f.value)}`, FIELD_TEXT_MAX) }));
    if (fields.length > 0) blocks.push({ type: 'section', fields });

    const context = [event.instanceName, formatted.subject];
    if (formatted.person) context.push(`Requested by ${formatted.person.name}`);
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(escapeMrkdwn(context.join(' · ')), SECTION_TEXT_MAX) }] });

    const buttons = linkButtons(formatted).slice(0, MAX_BUTTONS);
    if (buttons.length > 0) {
      blocks.push({
        type: 'actions',
        elements: buttons.map((b, i) => {
          const button: Extract<SlackBlock, { type: 'actions' }>['elements'][number] = {
            type: 'button',
            text: { type: 'plain_text', text: clip(b.label, BUTTON_TEXT_MAX), emoji: true },
            url: b.url,
            action_id: `arclight-link-${i}`,
          };
          if (/^approve/i.test(b.label)) button.style = 'primary';
          else if (/^decline/i.test(b.label)) button.style = 'danger';
          return button;
        }),
      });
    }

    // `text` is what notifications and screen readers get when the blocks cannot be shown.
    const fallback = templatedBody ? `${formatted.title}\n${formatted.body}` : `${formatted.subject}: ${formatted.title}`;
    const payload: SlackPayload = { text: clip(escapeMrkdwn(fallback), SECTION_TEXT_MAX), blocks };
    if (this.settings.channel) payload.channel = this.settings.channel;
    if (this.settings.username) payload.username = this.settings.username;
    if (this.settings.iconUrl) payload.icon_url = this.settings.iconUrl;
    else if (this.settings.iconEmoji) payload.icon_emoji = this.settings.iconEmoji;
    return payload;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    await httpRequest(this.fetch, this.kind, this.settings.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildPayload(event)),
      label: 'Slack webhook',
    });
  }
}

/** The event's actions first (approve/decline), then the item link unless an action already opens it. */
function linkButtons(formatted: FormattedEvent): FormattedAction[] {
  const out: FormattedAction[] = [...(formatted.actions ?? [])];
  if (formatted.link && !out.some((a) => a.url === formatted.link)) out.push({ label: 'Open', url: formatted.link });
  return out;
}

/** Slack mrkdwn treats &, < and > as control characters. */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
