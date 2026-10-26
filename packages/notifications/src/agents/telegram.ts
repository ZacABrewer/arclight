import { formatEvent } from '../format.js';
import { httpRequest, readJson } from '../http.js';
import type { TelegramSettings } from '../settings.js';
import { NotificationError, type NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

/** Characters MarkdownV2 requires escaping outside of entities. */
const MARKDOWN_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIAL, (c) => `\\${c}`);
}

export interface TelegramPayload {
  chat_id: string;
  text: string;
  parse_mode: 'MarkdownV2';
  disable_notification: boolean;
  message_thread_id?: number;
  link_preview_options: { is_disabled: boolean };
}

interface TelegramResponse {
  ok: boolean;
  description?: string;
}

export class TelegramAgent extends BaseAgent {
  readonly kind = 'telegram' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: TelegramSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): TelegramPayload {
    const formatted = formatEvent(event);
    const lines = [`*${escapeMarkdownV2(formatted.title)}*`, escapeMarkdownV2(formatted.subject)];
    for (const field of formatted.fields) {
      lines.push(`${escapeMarkdownV2(field.name)}: ${escapeMarkdownV2(field.value)}`);
    }
    if (formatted.actions && formatted.actions.length > 0) {
      lines.push(formatted.actions.map((a) => `[${escapeMarkdownV2(a.label)}](${escapeLinkUrl(a.url)})`).join(' \\| '));
    } else if (this.settings.includeLink && formatted.link) {
      lines.push(`[${escapeMarkdownV2('Open')}](${escapeLinkUrl(formatted.link)})`);
    }
    const payload: TelegramPayload = {
      chat_id: this.settings.chatId,
      text: lines.join('\n').slice(0, 4096),
      parse_mode: 'MarkdownV2',
      disable_notification: this.settings.sendSilently,
      link_preview_options: { is_disabled: !this.settings.includeLink },
    };
    if (this.settings.topicId !== undefined) payload.message_thread_id = this.settings.topicId;
    return payload;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const url = `https://api.telegram.org/bot${this.settings.botToken}/sendMessage`;
    const response = await httpRequest(this.fetch, this.kind, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildPayload(event)),
      label: 'Telegram API',
    });
    const body = await readJson<TelegramResponse>(response, this.kind);
    if (!body.ok) {
      throw new NotificationError(this.kind, 'remoteError', `Telegram rejected the message: ${body.description ?? 'unknown error'}`);
    }
  }
}

/** Inside an inline link URL only ")" and "\" need escaping. */
function escapeLinkUrl(url: string): string {
  return url.replace(/[)\\]/g, (c) => `\\${c}`);
}
