/**
 * Plex Media Server: find the library section whose folder contains the changed media and
 * ask it to scan just that path.
 */

import { hostUrl, httpRequest, joinUrl, readJson } from '../http.js';
import type { PlexSettings } from '../settings.js';
import { NotificationError, type MediaInfo, type NotificationEvent } from '../types.js';
import { BaseAgent, LIBRARY_EVENTS, type AgentDeps } from './base.js';

export interface PlexSection {
  key: string;
  title: string;
  /** "show" | "movie" | "artist" | "photo" */
  type: string;
  locations: string[];
}

interface PlexSectionsResponse {
  MediaContainer?: {
    Directory?: Array<{
      key?: string | number;
      title?: string;
      type?: string;
      Location?: Array<{ path?: string }>;
    }>;
  };
}

/** Normalise for prefix comparison: forward slashes, no trailing slash, case-insensitive on Windows-style paths. */
export function normalisePath(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(unified) ? unified.toLowerCase() : unified;
}

export function pathIsInside(child: string, parent: string): boolean {
  const c = normalisePath(child);
  const p = normalisePath(parent);
  return c === p || c.startsWith(`${p}/`);
}

export class PlexAgent extends BaseAgent {
  readonly kind = 'plex' as const;
  readonly supportedEvents = LIBRARY_EVENTS;

  constructor(
    private readonly settings: PlexSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  override async test(): Promise<void> {
    await this.request('identity');
  }

  async getSections(): Promise<PlexSection[]> {
    const response = await this.request('library/sections');
    const body = await readJson<PlexSectionsResponse>(response, this.kind);
    return (body.MediaContainer?.Directory ?? []).map((dir) => ({
      key: String(dir.key ?? ''),
      title: dir.title ?? '',
      type: dir.type ?? '',
      locations: (dir.Location ?? []).map((l) => l.path ?? '').filter((p) => p.length > 0),
    }));
  }

  /** Sections of the right type whose root folder contains `media.path`. */
  matchSections(sections: PlexSection[], media: MediaInfo): PlexSection[] {
    const wanted = media.mediaType === 'series' ? 'show' : 'movie';
    return sections.filter((s) => s.type === wanted && s.locations.some((loc) => pathIsInside(media.path, loc)));
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    if (event.type === 'test' || !this.settings.updateLibrary || !('media' in event)) return;
    const sections = this.matchSections(await this.getSections(), event.media);
    if (sections.length === 0) {
      throw new NotificationError(
        this.kind,
        'notFound',
        `No Plex ${event.media.mediaType === 'series' ? 'TV' : 'movie'} library contains "${event.media.path}"`,
      );
    }
    for (const section of sections) {
      await this.request(`library/sections/${encodeURIComponent(section.key)}/refresh`, { path: event.media.path });
    }
  }

  private async request(path: string, query: Record<string, string> = {}): Promise<Response> {
    const url = new URL(joinUrl(hostUrl(this.settings), path));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return httpRequest(this.fetch, this.kind, url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Plex-Token': this.settings.authToken,
        'X-Plex-Client-Identifier': 'media-tron',
        'X-Plex-Product': 'Media-Tron',
        'X-Plex-Device-Name': 'Media-Tron',
      },
    });
  }
}
