/**
 * Jellyfin and Emby share the MediaBrowser API: tell the server which folder changed so it
 * rescans just that, fall back to a full library refresh when the event has no path, and
 * (Emby only) show an admin notification.
 */

import { formatEvent } from '../format.js';
import { hostUrl, httpRequest, joinUrl } from '../http.js';
import type { EmbySettings, JellyfinSettings } from '../settings.js';
import type { NotificationEvent, NotificationEventType } from '../types.js';
import { BaseAgent, LIBRARY_EVENTS, type AgentDeps } from './base.js';

export type MediaBrowserKind = 'jellyfin' | 'emby';

export interface MediaBrowserUpdate {
  Path: string;
  UpdateType: 'Created' | 'Modified' | 'Deleted';
}

const EMBY_NOTIFY_EVENTS: ReadonlySet<NotificationEventType> = new Set<NotificationEventType>([
  'grab',
  'import',
  'upgrade',
  'healthIssue',
  'healthRestored',
  'applicationUpdate',
  'manualInteractionRequired',
]);

export class MediaBrowserAgent extends BaseAgent {
  readonly supportedEvents: ReadonlySet<NotificationEventType>;
  private readonly notify: boolean;

  constructor(
    readonly kind: MediaBrowserKind,
    private readonly settings: JellyfinSettings | EmbySettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
    this.notify = kind === 'emby' && 'notify' in settings && settings.notify;
    this.supportedEvents = this.notify ? new Set([...LIBRARY_EVENTS, ...EMBY_NOTIFY_EVENTS]) : LIBRARY_EVENTS;
  }

  /** What `send(event)` would do, as data, for tests and dry runs. */
  plan(event: NotificationEvent): { update?: MediaBrowserUpdate; fullRefresh: boolean; notify: boolean } {
    const notify = this.notify && EMBY_NOTIFY_EVENTS.has(event.type);
    if (!this.settings.updateLibrary || !LIBRARY_EVENTS.has(event.type) || event.type === 'test' || !('media' in event)) {
      return { fullRefresh: false, notify };
    }
    // Without a usable folder path the server can only rescan everything.
    if (!event.media.path) return { fullRefresh: true, notify };
    const updateType = event.type === 'mediaDeleted' ? 'Deleted' : 'Modified';
    return { update: { Path: event.media.path, UpdateType: updateType }, fullRefresh: false, notify };
  }

  override async test(): Promise<void> {
    await this.request('System/Info', 'GET');
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const plan = this.plan(event);
    if (plan.notify) {
      const formatted = formatEvent(event);
      await this.request('Notifications/Admin', 'POST', {
        Name: `${event.instanceName}: ${formatted.subject}`,
        Description: `${formatted.title}\n${formatted.body}`,
      });
    }
    if (plan.update) {
      await this.request('Library/Media/Updated', 'POST', { Updates: [plan.update] });
    } else if (plan.fullRefresh) {
      await this.request('Library/Refresh', 'POST');
    }
  }

  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-MediaBrowser-Token': this.settings.apiKey,
      Authorization: `MediaBrowser Token="${this.settings.apiKey}", Client="Arclight", Device="Arclight", DeviceId="arclight", Version="1"`,
    };
    const options: Parameters<typeof httpRequest>[3] = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return httpRequest(this.fetch, this.kind, joinUrl(hostUrl(this.settings), path), options);
  }
}
