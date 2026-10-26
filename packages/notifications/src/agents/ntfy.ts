import { formatEvent } from '../format.js';
import { basicAuthHeader, httpRequest, joinUrl } from '../http.js';
import type { NtfySettings } from '../settings.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export interface NtfyRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export class NtfyAgent extends BaseAgent {
  readonly kind = 'ntfy' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: NtfySettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildRequests(event: NotificationEvent): NtfyRequest[] {
    const formatted = formatEvent(event);
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      // ntfy reads metadata from headers; non-ASCII titles must be RFC 2047 encoded.
      Title: encodeHeader(formatted.title),
      Priority: String(this.settings.priority),
    };
    if (this.settings.tags.length > 0) headers.Tags = this.settings.tags.join(',');
    const click = this.settings.clickUrl ?? formatted.link;
    if (click) headers.Click = click;
    if (formatted.posterUrl) headers.Attach = formatted.posterUrl;
    if (this.settings.accessToken) {
      headers.Authorization = `Bearer ${this.settings.accessToken}`;
    } else if (this.settings.username && this.settings.password !== undefined) {
      headers.Authorization = basicAuthHeader(this.settings.username, this.settings.password);
    }
    return this.settings.topics.map((topic) => ({
      url: joinUrl(this.settings.serverUrl, encodeURIComponent(topic)),
      headers,
      body: formatted.body,
    }));
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    for (const request of this.buildRequests(event)) {
      await httpRequest(this.fetch, this.kind, request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
      });
    }
  }
}

function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}
