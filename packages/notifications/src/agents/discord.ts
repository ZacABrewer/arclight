import { formatBytes, formatEvent, qualityLabel, type FormattedField, type Severity } from '../format.js';
import { httpRequest } from '../http.js';
import type { DiscordField, DiscordSettings } from '../settings.js';
import type { NotificationEvent, MediaInfo, EpisodeInfo, ReleaseInfo, MediaFileInfo } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

/** Embed sidebar colours, as decimal RGB the Discord API expects. */
export const DISCORD_COLOURS: Record<Severity, number> = {
  info: 0x00c8ff, // cyan: something is happening
  success: 0x2ecc71, // green: it landed
  upgrade: 0x8e44ad, // purple: better than before
  warning: 0xf39c12, // amber: needs attention
  error: 0xe74c3c, // red: broken
};

export interface DiscordEmbed {
  author: { name: string; icon_url?: string };
  title: string;
  description: string;
  url?: string;
  color: number;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  thumbnail?: { url: string };
  image?: { url: string };
  timestamp: string;
}

export interface DiscordPayload {
  username?: string;
  avatar_url?: string;
  embeds: DiscordEmbed[];
}

export class DiscordAgent extends BaseAgent {
  readonly kind = 'discord' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: DiscordSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): DiscordPayload {
    const formatted = formatEvent(event);
    const selection = this.fieldSelection(event);
    const embed: DiscordEmbed = {
      author: { name: this.settings.author ?? event.instanceName },
      title: formatted.title,
      description: formatted.subject,
      color: DISCORD_COLOURS[formatted.severity],
      fields: [],
      timestamp: event.timestamp,
    };
    if (formatted.link) embed.url = formatted.link;
    if (this.settings.avatarUrl) embed.author.icon_url = this.settings.avatarUrl;

    if (selection) {
      // Grab / import / manual interaction: user picks which fields to show.
      const media = 'media' in event ? event.media : undefined;
      if (media) {
        if (selection.has('poster') && formatted.posterUrl) embed.thumbnail = { url: formatted.posterUrl };
        if (selection.has('fanart') && formatted.fanartUrl) embed.image = { url: formatted.fanartUrl };
      }
      embed.fields = this.selectedFields(event, selection, formatted.fields).map((f) => ({
        name: f.name,
        value: clip(f.value, 1024),
        inline: f.inline ?? false,
      }));
    } else {
      if (formatted.posterUrl) embed.thumbnail = { url: formatted.posterUrl };
      embed.fields = formatted.fields.map((f) => ({ name: f.name, value: clip(f.value, 1024), inline: f.inline ?? false }));
    }
    embed.fields = embed.fields.filter((f) => f.value.length > 0).slice(0, 25);

    const payload: DiscordPayload = { embeds: [embed] };
    if (this.settings.username) payload.username = this.settings.username;
    if (this.settings.avatarUrl) payload.avatar_url = this.settings.avatarUrl;
    return payload;
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    await httpRequest(this.fetch, this.kind, this.settings.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildPayload(event)),
      label: 'Discord webhook',
    });
  }

  private fieldSelection(event: NotificationEvent): Set<DiscordField> | undefined {
    switch (event.type) {
      case 'grab':
        return new Set(this.settings.grabFields);
      case 'import':
      case 'upgrade':
        return new Set(this.settings.importFields);
      case 'manualInteractionRequired':
        return new Set(this.settings.manualInteractionFields);
      default:
        return undefined;
    }
  }

  private selectedFields(
    event: NotificationEvent,
    selection: Set<DiscordField>,
    formatted: FormattedField[],
  ): FormattedField[] {
    const media: MediaInfo | undefined = 'media' in event ? event.media : undefined;
    const episodes: EpisodeInfo[] | undefined = 'episodes' in event ? event.episodes : undefined;
    const release: ReleaseInfo | undefined = 'release' in event ? event.release : undefined;
    const file: MediaFileInfo | undefined = 'file' in event ? event.file : undefined;
    const byName = new Map(formatted.map((f) => [f.name, f] as const));
    const out: FormattedField[] = [];

    for (const field of selection) {
      switch (field) {
        case 'overview': {
          const text = episodes?.[0]?.overview ?? media?.overview;
          if (text) out.push({ name: 'Overview', value: clip(text, 300) });
          break;
        }
        case 'rating':
          if (media?.rating !== undefined) out.push({ name: 'Rating', value: media.rating.toFixed(1), inline: true });
          break;
        case 'genres':
          if (media && media.genres.length > 0) out.push({ name: 'Genres', value: media.genres.slice(0, 5).join(', ') });
          break;
        case 'quality': {
          const q = file ?? release;
          if (q) out.push({ name: 'Quality', value: qualityLabel(q.quality, q.qualityVersion), inline: true });
          break;
        }
        case 'codecs':
          pushIf(out, byName.get('Codecs'));
          break;
        case 'group': {
          const group = file?.releaseGroup ?? release?.releaseGroup;
          if (group) out.push({ name: 'Group', value: group, inline: true });
          break;
        }
        case 'size': {
          const size = file?.size ?? release?.size;
          if (size !== undefined) out.push({ name: 'Size', value: formatBytes(size), inline: true });
          break;
        }
        case 'languages':
          pushIf(out, byName.get('Languages'));
          break;
        case 'subtitles':
          pushIf(out, byName.get('Subtitles'));
          break;
        case 'links':
          if (media) {
            const links: string[] = [];
            if (media.tmdbId > 0) {
              links.push(`[TMDB](https://www.themoviedb.org/${media.mediaType === 'series' ? 'tv' : 'movie'}/${media.tmdbId})`);
            }
            if (media.imdbId) links.push(`[IMDb](https://www.imdb.com/title/${media.imdbId}/)`);
            if (media.tvdbId) links.push(`[TVDB](https://www.thetvdb.com/?tab=series&id=${media.tvdbId})`);
            if (links.length > 0) out.push({ name: 'Links', value: links.join(' / ') });
          }
          break;
        case 'release': {
          const title = release?.title ?? file?.sceneName ?? (event.type === 'manualInteractionRequired' ? event.downloadTitle : undefined);
          if (title) out.push({ name: 'Release', value: `\`\`\`${title}\`\`\`` });
          break;
        }
        case 'indexer':
          if (release?.indexer) out.push({ name: 'Indexer', value: release.indexer, inline: true });
          break;
        case 'customFormats':
          if (release && release.customFormats.length > 0) {
            out.push({ name: 'Custom Formats', value: release.customFormats.join(', ') });
          }
          break;
        case 'customFormatScore':
          if (release) out.push({ name: 'Custom Format Score', value: String(release.customFormatScore), inline: true });
          break;
        case 'poster':
        case 'fanart':
          break; // handled as embed images
      }
    }

    if (event.type === 'upgrade') pushIf(out, byName.get('Replaced'));
    if (event.type === 'manualInteractionRequired') {
      pushIf(out, byName.get('Status'));
      for (const status of event.statusMessages) pushIf(out, byName.get(status.title));
    }
    return out;
  }
}

function pushIf(out: FormattedField[], field: FormattedField | undefined): void {
  if (field) out.push(field);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
