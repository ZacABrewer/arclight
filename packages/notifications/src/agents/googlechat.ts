/**
 * Google Chat via a space's incoming webhook. Sends a card (cardsV2) with the poster in the
 * header, the fields as labelled rows, and link buttons. Card text accepts a small HTML subset,
 * so everything from the event is HTML-escaped.
 */

import { z } from 'zod';
import type { FormattedAction, FormattedEvent } from '../format.js';
import { httpRequest } from '../http.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const GoogleChatSettings = z.object({
  webhookUrl: z
    .url({ protocol: /^https?$/ })
    .describe('Space webhook URL (space > Apps & integrations > Webhooks). It carries the key and token in its query string.'),
  threadKey: z
    .string()
    .max(200)
    .optional()
    .describe('Post every message into this thread (created on first use). Leave blank for a new thread per message.'),
});
export type GoogleChatSettings = z.infer<typeof GoogleChatSettings>;

const TEXT_MAX = 4000;
const MAX_FIELDS = 20;
const MAX_BUTTONS = 5;

export type GoogleChatWidget =
  | { decoratedText: { topLabel: string; text: string; wrapText: true } }
  | { textParagraph: { text: string } }
  | { buttonList: { buttons: Array<{ text: string; onClick: { openLink: { url: string } } }> } };

export interface GoogleChatCard {
  header: { title: string; subtitle: string; imageUrl?: string; imageType?: 'SQUARE' | 'CIRCLE'; imageAltText?: string };
  sections: Array<{ widgets: GoogleChatWidget[] }>;
}

export interface GoogleChatPayload {
  text: string;
  cardsV2: Array<{ cardId: string; card: GoogleChatCard }>;
}

export class GoogleChatAgent extends BaseAgent {
  readonly kind = 'googlechat' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: GoogleChatSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): GoogleChatPayload {
    const formatted = this.format(event);
    const header: GoogleChatCard['header'] = {
      title: clip(formatted.title, 200),
      subtitle: clip(`${formatted.subject} · ${event.instanceName}`, 200),
    };
    if (formatted.posterUrl) {
      header.imageUrl = formatted.posterUrl;
      header.imageType = 'SQUARE';
      header.imageAltText = 'Poster';
    }

    const content: GoogleChatWidget[] = [];
    if (formatted.templated?.body) content.push({ textParagraph: { text: html(clip(formatted.body, TEXT_MAX)) } });
    for (const field of formatted.fields.filter((f) => f.value.length > 0).slice(0, MAX_FIELDS)) {
      content.push({ decoratedText: { topLabel: clip(field.name, 100), text: html(clip(field.value, TEXT_MAX)), wrapText: true } });
    }
    if (formatted.person) content.push({ textParagraph: { text: `Requested by <b>${html(formatted.person.name)}</b>` } });

    const sections: GoogleChatCard['sections'] = [];
    if (content.length > 0) sections.push({ widgets: content });
    const buttons = linkButtons(formatted).slice(0, MAX_BUTTONS);
    if (buttons.length > 0) {
      sections.push({ widgets: [{ buttonList: { buttons: buttons.map((b) => ({ text: clip(b.label, 40), onClick: { openLink: { url: b.url } } })) } }] });
    }

    return {
      // Plain text shown in push notifications and clients that cannot render cards.
      text: clip(`${formatted.subject}: ${formatted.title}`, TEXT_MAX),
      cardsV2: [{ cardId: `arclight-${event.type}`, card: { header, sections } }],
    };
  }

  /** The webhook URL, plus the thread parameters when a thread key is set. */
  buildUrl(): string {
    if (!this.settings.threadKey) return this.settings.webhookUrl;
    const url = new URL(this.settings.webhookUrl);
    url.searchParams.set('threadKey', this.settings.threadKey);
    url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
    return url.toString();
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    await httpRequest(this.fetch, this.kind, this.buildUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(this.buildPayload(event)),
      label: 'Google Chat webhook',
    });
  }
}

/** The event's actions first (approve/decline), then the item link unless an action already opens it. */
function linkButtons(formatted: FormattedEvent): FormattedAction[] {
  const out: FormattedAction[] = [...(formatted.actions ?? [])];
  if (formatted.link && !out.some((a) => a.url === formatted.link)) out.push({ label: 'Open', url: formatted.link });
  return out;
}

/** Escape for Chat's card HTML subset; line breaks become <br>. */
function html(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
