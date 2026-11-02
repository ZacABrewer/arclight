/**
 * Apprise API (a self-hosted caronc/apprise-api server), which fans one message out to any of
 * Apprise's 100+ services. Stateful: POST /notify/{key} uses a configuration saved on the server
 * (optionally narrowed by tags). Stateless: POST /notify carries the Apprise URLs itself.
 */

import { z } from 'zod';
import type { FormattedEvent, Severity } from '../format.js';
import { basicAuthHeader, httpRequest, joinUrl } from '../http.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const AppriseSettings = z
  .object({
    serverUrl: z.url({ protocol: /^https?$/ }).describe('Apprise API server URL, e.g. http://apprise:8000.'),
    configKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/, 'Letters, digits, "-" and "_" only (max 128)')
      .optional()
      .describe('Key of a configuration saved on the Apprise API server (stateful). Use this or Apprise URLs.'),
    urls: z
      .array(z.string().min(1))
      .optional()
      .describe('Apprise URLs to notify, e.g. tgram://bottoken/ChatID (stateless). Use this or a config key.'),
    tags: z.array(z.string().min(1)).default([]).describe('Only notify services with these tags (config key only). Empty notifies all.'),
    format: z.enum(['text', 'markdown', 'html']).default('markdown').describe('How the body is formatted for services that support it.'),
    attachPoster: z.boolean().default(false).describe('Attach the poster image (the server downloads it from its URL).'),
    username: z.string().optional().describe('Basic auth username, when the server sits behind a proxy that requires it.'),
    password: z.string().optional().describe('Basic auth password.'),
  })
  .refine((s) => (s.configKey !== undefined) !== (s.urls !== undefined && s.urls.length > 0), {
    message: 'Set exactly one of a config key or Apprise URLs',
    path: ['configKey'],
  });
export type AppriseSettings = z.infer<typeof AppriseSettings>;

export type AppriseType = 'info' | 'success' | 'warning' | 'failure';

export interface ApprisePayload {
  title: string;
  body: string;
  type: AppriseType;
  format: 'text' | 'markdown' | 'html';
  tag?: string;
  urls?: string;
  attach?: string;
}

export function appriseType(severity: Severity): AppriseType {
  switch (severity) {
    case 'error':
      return 'failure';
    case 'warning':
      return 'warning';
    case 'success':
    case 'upgrade':
      return 'success';
    default:
      return 'info';
  }
}

/** The media link plus action links, without duplicate URLs. */
function links(formatted: FormattedEvent): Array<{ label: string; url: string }> {
  const out: Array<{ label: string; url: string }> = [];
  if (formatted.link) out.push({ label: 'Open', url: formatted.link });
  for (const action of formatted.actions ?? []) {
    if (!out.some((l) => l.url === action.url)) out.push(action);
  }
  return out;
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The default body ends with the link or "Label: url" action lines; drop them so they are not sent twice. */
function bodyWithoutLinks(formatted: FormattedEvent): string {
  const tail = new Set<string>(formatted.actions?.map((a) => `${a.label}: ${a.url}`) ?? []);
  if (formatted.link) tail.add(formatted.link);
  const lines = formatted.body.split('\n');
  while (lines.length > 1 && tail.has(lines[lines.length - 1] ?? '')) lines.pop();
  return lines.join('\n');
}

export function appriseBody(formatted: FormattedEvent, format: ApprisePayload['format']): string {
  const list = links(formatted);
  const text = bodyWithoutLinks(formatted);
  if (format === 'html') {
    const body = escapeHtml(text).replace(/\n/g, '<br>');
    const anchors = list.map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join(' | ');
    return anchors ? `${body}<br><br>${anchors}` : body;
  }
  if (format === 'markdown') {
    const anchors = list.map((l) => `[${l.label.replace(/[[\]]/g, '')}](${l.url.replace(/\)/g, '%29')})`).join(' | ');
    return anchors ? `${text}\n\n${anchors}` : text;
  }
  const lines = list.map((l) => `${l.label}: ${l.url}`).join('\n');
  return lines ? `${text}\n\n${lines}` : text;
}

export class AppriseAgent extends BaseAgent {
  readonly kind = 'apprise' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: AppriseSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildUrl(): string {
    return this.settings.configKey
      ? joinUrl(this.settings.serverUrl, `notify/${encodeURIComponent(this.settings.configKey)}`)
      : joinUrl(this.settings.serverUrl, 'notify');
  }

  buildPayload(event: NotificationEvent): ApprisePayload {
    const formatted = this.format(event);
    const payload: ApprisePayload = {
      title: formatted.title,
      body: appriseBody(formatted, this.settings.format),
      type: appriseType(formatted.severity),
      format: this.settings.format,
    };
    if (this.settings.configKey) {
      if (this.settings.tags.length > 0) payload.tag = this.settings.tags.join(',');
    } else if (this.settings.urls) {
      payload.urls = this.settings.urls.join(',');
    }
    if (this.settings.attachPoster && formatted.posterUrl) payload.attach = formatted.posterUrl;
    return payload;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.settings.username && this.settings.password !== undefined) {
      headers.Authorization = basicAuthHeader(this.settings.username, this.settings.password);
    }
    // The config key in the path, and the URLs in the body, are both secrets: never echo either.
    await httpRequest(this.fetch, this.kind, this.buildUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify(this.buildPayload(event)),
      label: 'Apprise API',
    });
  }
}
