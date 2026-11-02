/**
 * Matrix via the client-server API: one m.room.message per event, with a plain-text body and
 * an HTML `formatted_body`. Room aliases (#room:server) are resolved to a room id once.
 */

import { z } from 'zod';
import type { FormattedAction, FormattedEvent } from '../format.js';
import { httpRequest, joinUrl, readJson } from '../http.js';
import { NotificationError, type NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const MatrixSettings = z.object({
  homeserverUrl: z.url({ protocol: /^https?$/ }).default('https://matrix.org').describe('Homeserver base URL, e.g. https://matrix.example.com.'),
  accessToken: z.string().min(1).describe('Access token of the account that posts (a dedicated bot account is best). It must already be in the room.'),
  roomId: z
    .string()
    .regex(/^[!#][^:\s]+:\S+$/, 'Use a room id (!abc:example.com) or alias (#room:example.com)')
    .describe('Room id (!abc:example.com, from Room settings > Advanced) or room alias (#room:example.com).'),
  msgtype: z
    .enum(['m.notice', 'm.text'])
    .default('m.notice')
    .describe('m.notice marks the message as from a bot (clients may not ping for it); m.text sends it as a normal message.'),
});
export type MatrixSettings = z.infer<typeof MatrixSettings>;

const BODY_MAX = 16_000;

export interface MatrixMessage {
  msgtype: 'm.notice' | 'm.text';
  body: string;
  format: 'org.matrix.custom.html';
  formatted_body: string;
}

let txnCounter = 0;

export class MatrixAgent extends BaseAgent {
  readonly kind = 'matrix' as const;
  readonly supportedEvents = MESSAGE_EVENTS;
  private resolvedRoomId: string | undefined;

  constructor(
    private readonly settings: MatrixSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): MatrixMessage {
    const formatted = this.format(event);
    const links = linkList(formatted);
    const plain: string[] = [formatted.title];
    const rich: string[] = [
      formatted.link ? `<b><a href="${attr(formatted.link)}">${esc(formatted.title)}</a></b>` : `<b>${esc(formatted.title)}</b>`,
    ];

    if (formatted.templated?.body) {
      plain.push(formatted.body);
      rich.push(lines(formatted.body));
    } else {
      plain.push(formatted.subject);
      rich.push(`<i>${esc(formatted.subject)}</i>`);
      for (const field of formatted.fields.filter((f) => f.value.length > 0)) {
        plain.push(`${field.name}: ${field.value}`);
        rich.push(`<b>${esc(field.name)}:</b> ${lines(field.value)}`);
      }
    }
    if (formatted.person) {
      plain.push(`Requested by ${formatted.person.name}`);
      rich.push(`Requested by ${esc(formatted.person.name)}`);
    }
    if (links.length > 0) {
      plain.push(...links.map((l) => `${l.label}: ${l.url}`));
      rich.push(links.map((l) => `<a href="${attr(l.url)}">${esc(l.label)}</a>`).join(' · '));
    }

    return {
      msgtype: this.settings.msgtype,
      body: clip(plain.join('\n'), BODY_MAX),
      format: 'org.matrix.custom.html',
      // Clipping HTML could cut a tag in half, so cap the line count instead.
      formatted_body: capHtml(rich, BODY_MAX),
    };
  }

  /** A transaction id unique per send, so the homeserver can de-duplicate retries. */
  nextTxnId(): string {
    txnCounter += 1;
    return `arclight-${this.now().getTime()}-${txnCounter}`;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const roomId = await this.roomId();
    const url = joinUrl(
      this.settings.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(this.nextTxnId())}`,
    );
    await httpRequest(this.fetch, this.kind, url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.settings.accessToken}` },
      body: JSON.stringify(this.buildPayload(event)),
    });
  }

  private async roomId(): Promise<string> {
    if (this.settings.roomId.startsWith('!')) return this.settings.roomId;
    if (this.resolvedRoomId) return this.resolvedRoomId;
    const url = joinUrl(this.settings.homeserverUrl, `/_matrix/client/v3/directory/room/${encodeURIComponent(this.settings.roomId)}`);
    const response = await httpRequest(this.fetch, this.kind, url, {
      headers: { Authorization: `Bearer ${this.settings.accessToken}` },
    });
    const body = await readJson<{ room_id?: unknown }>(response, this.kind);
    if (typeof body.room_id !== 'string' || !body.room_id.startsWith('!')) {
      throw new NotificationError(this.kind, 'notFound', `Room alias ${this.settings.roomId} did not resolve to a room id`);
    }
    this.resolvedRoomId = body.room_id;
    return body.room_id;
  }
}

/** The event's actions first (approve/decline), then the item link unless an action already opens it. */
function linkList(formatted: FormattedEvent): FormattedAction[] {
  const out: FormattedAction[] = [...(formatted.actions ?? [])];
  if (formatted.link && !out.some((a) => a.url === formatted.link)) out.push({ label: 'Open', url: formatted.link });
  return out;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const attr = esc;

/** Escaped text with its line breaks kept. */
function lines(text: string): string {
  return esc(text).replace(/\n/g, '<br>');
}

function capHtml(parts: string[], max: number): string {
  const out: string[] = [];
  let length = 0;
  for (const part of parts) {
    const piece = part.length > max ? '' : part;
    if (length + piece.length + 4 > max) break;
    out.push(piece);
    length += piece.length + 4;
  }
  return out.filter((p) => p.length > 0).join('<br>');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
