/**
 * Mattermost via an incoming webhook. Uses the Slack-compatible message attachment: a coloured
 * sidebar, linked title, fields in columns and the poster as a thumbnail. Incoming webhooks
 * cannot carry link buttons, so the deep links go into the text as Markdown links.
 */

import { z } from 'zod';
import type { FormattedAction, FormattedEvent, Severity } from '../format.js';
import { httpRequest } from '../http.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const MattermostSettings = z.object({
  webhookUrl: z.url({ protocol: /^https?$/ }).describe('Incoming webhook URL (Integrations > Incoming Webhooks > Add).'),
  channel: z.string().max(64).optional().describe('Override the channel by its name (the URL handle, e.g. town-square), if the webhook allows it.'),
  username: z.string().max(64).optional().describe('Override the sender name (needs "Enable integrations to override usernames").'),
  iconUrl: z.url({ protocol: /^https?$/ }).optional().describe('Override the sender icon (needs "Enable integrations to override profile picture icons").'),
});
export type MattermostSettings = z.infer<typeof MattermostSettings>;

export const MATTERMOST_COLOURS: Record<Severity, string> = {
  info: '#00c8ff',
  success: '#2ecc71',
  upgrade: '#8e44ad',
  warning: '#f39c12',
  error: '#e74c3c',
};

const TEXT_MAX = 7000;
const FIELD_VALUE_MAX = 1000;
const MAX_FIELDS = 20;

export interface MattermostAttachment {
  fallback: string;
  color: string;
  title: string;
  title_link?: string;
  text: string;
  author_name?: string;
  author_icon?: string;
  fields: Array<{ short: boolean; title: string; value: string }>;
  thumb_url?: string;
  footer: string;
}

export interface MattermostPayload {
  channel?: string;
  username?: string;
  icon_url?: string;
  attachments: MattermostAttachment[];
}

export class MattermostAgent extends BaseAgent {
  readonly kind = 'mattermost' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: MattermostSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): MattermostPayload {
    const formatted = this.format(event);
    const lines = [formatted.templated?.body ? formatted.body : formatted.subject];
    const links = linkList(formatted);
    if (links.length > 0) lines.push(links.map((l) => `[${l.label.replace(/[[\]]/g, '')}](${l.url})`).join(' · '));

    const attachment: MattermostAttachment = {
      fallback: clip(`${formatted.subject}: ${formatted.title}`, 500),
      color: MATTERMOST_COLOURS[formatted.severity],
      title: clip(formatted.title, 250),
      text: clip(lines.join('\n\n'), TEXT_MAX),
      fields: formatted.fields
        .filter((f) => f.value.length > 0)
        .slice(0, MAX_FIELDS)
        .map((f) => ({ short: f.inline ?? false, title: f.name, value: clip(f.value, FIELD_VALUE_MAX) })),
      footer: event.instanceName,
    };
    if (formatted.link) attachment.title_link = formatted.link;
    if (formatted.posterUrl) attachment.thumb_url = formatted.posterUrl;
    if (formatted.person) {
      attachment.author_name = `Requested by ${formatted.person.name}`;
      if (formatted.person.avatarUrl && /^https?:\/\//.test(formatted.person.avatarUrl)) attachment.author_icon = formatted.person.avatarUrl;
    }

    const payload: MattermostPayload = { attachments: [attachment] };
    if (this.settings.channel) payload.channel = this.settings.channel;
    if (this.settings.username) payload.username = this.settings.username;
    if (this.settings.iconUrl) payload.icon_url = this.settings.iconUrl;
    return payload;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    await httpRequest(this.fetch, this.kind, this.settings.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildPayload(event)),
      label: 'Mattermost webhook',
    });
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
