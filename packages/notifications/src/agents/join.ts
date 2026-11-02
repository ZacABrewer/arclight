/**
 * Join by joaoapps: a GET to the messaging API's sendPush call with everything in the query
 * string, the API key included, so requests are labelled "Join API" and never echo the URL.
 */

import { z } from 'zod';
import { httpRequest, readJson } from '../http.js';
import { NotificationError, type NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const JOIN_URL = 'https://joinjoaomgcd.appspot.com/_ah/api/messaging/v1/sendPush';

export const JoinSettings = z.object({
  apiKey: z.string().min(1).describe('Join API key (Join web app > Join API > Show).'),
  deviceIds: z.array(z.string().min(1)).default([]).describe('Device ids to notify. Leave empty to notify all of your devices.'),
  deviceNames: z
    .array(z.string().min(1))
    .default([])
    .describe('Device names to notify instead of ids. Used only when no device ids are set.'),
  priority: z.number().int().min(-2).max(2).default(0).describe('Android notification priority, -2 (lowest) to 2 (highest).'),
});
export type JoinSettings = z.infer<typeof JoinSettings>;

interface JoinResponse {
  success?: boolean;
  errorMessage?: string;
}

export class JoinAgent extends BaseAgent {
  readonly kind = 'join' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: JoinSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  /** The query parameters, as a map so tests can read them. */
  buildQuery(event: NotificationEvent): Record<string, string> {
    const formatted = this.format(event);
    const query: Record<string, string> = { apikey: this.settings.apiKey };
    if (this.settings.deviceIds.length > 0) query.deviceId = this.settings.deviceIds.join(',');
    else if (this.settings.deviceNames.length > 0) query.deviceNames = this.settings.deviceNames.join(',');
    else query.deviceId = 'group.all';
    query.title = formatted.title;
    query.text = formatted.body;
    if (formatted.posterUrl) {
      query.icon = formatted.posterUrl;
      query.image = formatted.posterUrl;
    }
    if (formatted.link) query.url = formatted.link;
    query.group = 'Arclight';
    query.priority = String(this.settings.priority);
    return query;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const url = `${JOIN_URL}?${new URLSearchParams(this.buildQuery(event)).toString()}`;
    const response = await httpRequest(this.fetch, this.kind, url, { method: 'GET', label: 'Join API' });
    const body = await readJson<JoinResponse>(response, this.kind);
    if (body.success === false) {
      const detail = body.errorMessage ?? 'unknown error';
      throw new NotificationError(this.kind, /api ?key/i.test(detail) ? 'unauthorized' : 'remoteError', `Join rejected the message: ${detail}`);
    }
  }
}
