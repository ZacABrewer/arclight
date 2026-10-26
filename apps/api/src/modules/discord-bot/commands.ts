import type { SearchResult } from '@arclight/metadata';
import { Permission, type MediaRequest, type MediaStatus, type MediaType } from '@arclight/shared';
import type { Logger } from 'pino';
import { RequestsError, SYSTEM_ACTOR, can, effectivePermissions, type Actor, type RequestsService } from '../requests/index.js';
import type { DiscordActionRow, DiscordButton, DiscordEmbed, DiscordMessage, DiscordRest, SlashCommand } from './rest.js';

// Slash commands and button interactions. Every interaction is acknowledged at once
// (deferred, ephemeral) and answered by editing the original response, so TMDB lookups and
// approvals never hit Discord's 3-second limit.

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'request',
    description: 'Request a movie or series',
    options: [
      { type: 3, name: 'title', description: 'Title to search for', required: true },
      { type: 4, name: 'year', description: 'Release year' },
      { type: 5, name: '4k', description: 'Request the 4K version' },
    ],
  },
  { name: 'link', description: 'Link your Discord account to Arclight', options: [{ type: 3, name: 'code', description: 'Code from your Arclight profile', required: true }] },
  { name: 'status', description: 'Status of your requests', options: [{ type: 3, name: 'title', description: 'Only requests matching this title' }] },
  { name: 'search', description: 'Search titles and see whether they are in the library', options: [{ type: 3, name: 'title', description: 'Title to search for', required: true }] },
  { name: 'pending', description: 'Pending requests (admins)' },
];

export const EPHEMERAL = 64;
const COLOURS = { info: 0x00c8ff, success: 0x2ecc71, warning: 0xf39c12, error: 0xe74c3c } as const;

export interface DiscordInteraction {
  id: string;
  token: string;
  /** 2 application command, 3 message component. */
  type: number;
  guild_id?: string;
  data?: { name?: string; custom_id?: string; options?: { name: string; value: unknown }[] };
  member?: { user?: { id: string; username: string }; roles?: string[] };
  user?: { id: string; username: string };
}

export interface LinkedUser {
  id: number;
  username: string;
  role: string;
  permissions: number;
}

export interface CommandDeps {
  rest: () => DiscordRest | null;
  applicationId: () => string | null;
  requests: RequestsService;
  adminRoleId: () => string | null;
  linkedUser: (discordUserId: string) => LinkedUser | undefined;
  /** Consumes a link code; returns the Arclight username or null when the code is unknown/expired. */
  redeemLinkCode: (code: string, discordUserId: string) => string | null;
  log?: Logger;
}

const NOT_LINKED =
  'Your Discord account is not linked to Arclight yet. Open Arclight, go to Profile > Discord, create a link code and run `/link <code>` here.';

const STATUS_LABEL: Record<MediaStatus, string> = {
  unknown: 'Not requested',
  pending: 'Requested',
  processing: 'Processing',
  partiallyAvailable: 'Partially available',
  available: 'Available',
};

function option(i: DiscordInteraction, name: string): unknown {
  return i.data?.options?.find((o) => o.name === name)?.value;
}

function label(r: Pick<SearchResult, 'title' | 'year' | 'mediaType'>): string {
  const text = `${r.title}${r.year ? ` (${r.year})` : ''} ${r.mediaType === 'movie' ? '[movie]' : '[series]'}`;
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function requestLine(r: MediaRequest): string {
  const status = r.status === 'approved' || r.status === 'completed' ? STATUS_LABEL[r.mediaStatus] : r.status;
  return `#${r.id} ${r.mediaTitle}${r.mediaYear ? ` (${r.mediaYear})` : ''}${r.is4k ? ' 4K' : ''}: ${status}`;
}

function text(content: string): DiscordMessage {
  return { content, embeds: [], components: [] };
}

export function actorFor(user: LinkedUser): Actor {
  return { userId: user.id, permissions: effectivePermissions(user) };
}

export class CommandHandler {
  constructor(private readonly deps: CommandDeps) {}

  private discordUser(i: DiscordInteraction): { id: string; username: string } | undefined {
    return i.member?.user ?? i.user;
  }

  /** Acknowledges, runs the command, then edits the original response. */
  async handle(i: DiscordInteraction): Promise<void> {
    const rest = this.deps.rest();
    const appId = this.deps.applicationId();
    if (!rest || !appId) return;
    const isCommand = i.type === 2;
    if (!isCommand && i.type !== 3) return;
    await rest.interactionCallback(i.id, i.token, isCommand ? 5 : 6, isCommand ? { flags: EPHEMERAL } : undefined);
    let reply: DiscordMessage;
    try {
      reply = isCommand ? await this.command(i) : await this.component(i);
    } catch (err) {
      this.deps.log?.warn({ err }, 'Discord interaction failed');
      reply = text(friendlyError(err));
    }
    await rest.editOriginal(appId, i.token, reply);
  }

  private async command(i: DiscordInteraction): Promise<DiscordMessage> {
    const who = this.discordUser(i);
    if (!who) return text('Could not tell who sent this command.');
    switch (i.data?.name) {
      case 'link':
        return this.link(who.id, String(option(i, 'code') ?? ''));
      case 'request':
        return this.requestSearch(who.id, String(option(i, 'title') ?? ''), option(i, 'year'), option(i, '4k') === true);
      case 'status':
        return this.status(who.id, option(i, 'title'));
      case 'search':
        return this.search(String(option(i, 'title') ?? ''));
      case 'pending':
        return this.pending(i);
      default:
        return text(`Unknown command ${i.data?.name ?? ''}.`);
    }
  }

  private async component(i: DiscordInteraction): Promise<DiscordMessage> {
    const who = this.discordUser(i);
    const id = i.data?.custom_id ?? '';
    if (!who) return text('Could not tell who clicked this.');
    const req = /^req:(movie|series):(\d+):([01])$/.exec(id);
    if (req) return this.createRequest(who.id, req[1] as MediaType, Number(req[2]), req[3] === '1');
    const act = /^(appr|decl):(\d+)$/.exec(id);
    if (act) return this.decide(i, act[1] === 'appr' ? 'approve' : 'decline', Number(act[2]));
    return text('This button is no longer supported.');
  }

  // ------------------------------------------------------------------------------- link

  private link(discordUserId: string, code: string): DiscordMessage {
    const username = this.deps.redeemLinkCode(code.trim().toUpperCase(), discordUserId);
    if (!username) return text('That link code is unknown or expired. Create a new one under Profile > Discord in Arclight.');
    return text(`Linked to Arclight user **${username}**. You can now use /request and /status.`);
  }

  // ------------------------------------------------------------------------------- request

  private async searchTitles(query: string): Promise<SearchResult[]> {
    const client = this.deps.requests.titles.client();
    return (await client.searchMulti(query, { page: 1 })).results;
  }

  private async requestSearch(discordUserId: string, title: string, year: unknown, is4k: boolean): Promise<DiscordMessage> {
    if (!this.deps.linkedUser(discordUserId)) return text(NOT_LINKED);
    let results = await this.searchTitles(title);
    if (typeof year === 'number') results = results.filter((r) => r.year === year);
    results = results.slice(0, 5);
    if (results.length === 0) return text(`Nothing found for "${title}"${typeof year === 'number' ? ` (${year})` : ''}.`);
    const buttons: DiscordButton[] = results.map((r) => ({
      type: 2,
      style: 1,
      label: label(r),
      custom_id: `req:${r.mediaType}:${r.tmdbId}:${is4k ? 1 : 0}`,
    }));
    return {
      content: `Pick the title to request${is4k ? ' in 4K' : ''}:`,
      embeds: [],
      components: [{ type: 1, components: buttons }],
    };
  }

  private async createRequest(discordUserId: string, type: MediaType, tmdbId: number, is4k: boolean): Promise<DiscordMessage> {
    const user = this.deps.linkedUser(discordUserId);
    if (!user) return text(NOT_LINKED);
    const outcome = await this.deps.requests.create(actorFor(user), {
      mediaType: type,
      tmdbId,
      is4k,
      ...(type === 'series' ? { seasons: 'all' as const } : {}),
    });
    if (outcome.kind === 'accepted') return text(`Nothing to request: ${outcome.message}.`);
    const r = outcome.request;
    const verb = r.status === 'pending' ? 'is waiting for approval' : r.status === 'failed' ? `failed: ${r.failureReason ?? 'unknown error'}` : 'was approved';
    return { content: '', embeds: [requestEmbed(r, `Request ${verb}`)], components: [] };
  }

  // ------------------------------------------------------------------------------- status / search

  private status(discordUserId: string, title: unknown): DiscordMessage {
    const user = this.deps.linkedUser(discordUserId);
    if (!user) return text(NOT_LINKED);
    const page = this.deps.requests.list(actorFor(user), { take: 100, requestedBy: user.id });
    const needle = typeof title === 'string' ? title.trim().toLowerCase() : '';
    const rows = page.results.filter((r) => !needle || r.mediaTitle.toLowerCase().includes(needle)).slice(0, 10);
    if (rows.length === 0) return text(needle ? `You have no requests matching "${title as string}".` : 'You have no requests yet.');
    return {
      content: '',
      embeds: [{ title: 'Your requests', description: rows.map(requestLine).join('\n'), color: COLOURS.info }],
      components: [],
    };
  }

  private async search(title: string): Promise<DiscordMessage> {
    const results = (await this.searchTitles(title)).slice(0, 5);
    if (results.length === 0) return text(`Nothing found for "${title}".`);
    const statuses = {
      movie: this.deps.requests.titleStatuses('movie', results.filter((r) => r.mediaType === 'movie').map((r) => r.tmdbId)),
      series: this.deps.requests.titleStatuses('series', results.filter((r) => r.mediaType === 'series').map((r) => r.tmdbId)),
    };
    const fields = results.map((r) => {
      const st = statuses[r.mediaType].get(r.tmdbId);
      const status = st ? STATUS_LABEL[st.status] : STATUS_LABEL.unknown;
      const uhd = st && st.status4k !== 'unknown' ? ` / 4K: ${STATUS_LABEL[st.status4k]}` : '';
      return { name: label(r), value: `${status}${uhd}${st?.libraryId ? ' (in library)' : ''}`, inline: false };
    });
    return { content: '', embeds: [{ title: `Search: ${title}`, color: COLOURS.info, fields }], components: [] };
  }

  // ------------------------------------------------------------------------------- pending

  /**
   * Who may manage requests from Discord: a linked user holding MANAGE_REQUESTS acts as
   * themselves; a member with the configured admin role who is not such a user acts as the
   * system (the role is a delegation of admin rights; modifiedBy stays empty). Re-checked on
   * every button click.
   */
  private manager(i: DiscordInteraction): Actor | null {
    const who = this.discordUser(i);
    if (!who) return null;
    const linked = this.deps.linkedUser(who.id);
    if (linked) {
      const actor = actorFor(linked);
      if (can(actor.permissions, Permission.MANAGE_REQUESTS)) return actor;
    }
    const role = this.deps.adminRoleId();
    if (role && i.guild_id && (i.member?.roles ?? []).includes(role)) return SYSTEM_ACTOR;
    return null;
  }

  private pending(i: DiscordInteraction): DiscordMessage {
    const actor = this.manager(i);
    if (!actor) return text('Only Arclight request managers (or members with the admin role) can use /pending.');
    const page = this.deps.requests.list(actor, { filter: 'pending', take: 5, sort: 'added', sortDirection: 'asc' });
    if (page.results.length === 0) return text('No pending requests.');
    const rows: DiscordActionRow[] = page.results.map((r) => ({
      type: 1,
      components: [
        { type: 2, style: 3, label: `Approve #${r.id}`, custom_id: `appr:${r.id}` },
        { type: 2, style: 4, label: `Decline #${r.id}`, custom_id: `decl:${r.id}` },
      ],
    }));
    const more = page.pageInfo.total > page.results.length ? `\n...and ${page.pageInfo.total - page.results.length} more` : '';
    return {
      content: '',
      embeds: [
        {
          title: `Pending requests (${page.pageInfo.total})`,
          description: page.results.map((r) => `${requestLine(r)} by ${r.requestedBy.displayName ?? r.requestedBy.username}`).join('\n') + more,
          color: COLOURS.warning,
        },
      ],
      components: rows,
    };
  }

  private async decide(i: DiscordInteraction, action: 'approve' | 'decline', id: number): Promise<DiscordMessage> {
    const actor = this.manager(i);
    if (!actor) return text('You may not approve or decline requests.');
    const r = action === 'approve' ? await this.deps.requests.approve(actor, id, {}) : await this.deps.requests.decline(actor, id, 'Declined from Discord');
    return { content: '', embeds: [requestEmbed(r, action === 'approve' ? 'Request approved' : 'Request declined')], components: [] };
  }
}

export function friendlyError(err: unknown): string {
  if (err instanceof RequestsError) {
    switch (err.code) {
      case 'CONFLICT':
        return `Already taken care of: ${err.message}.`;
      case 'FORBIDDEN':
        return `Not allowed: ${err.message}.`;
      case 'NOT_FOUND':
        return 'That title could not be found.';
      case 'NOT_CONFIGURED':
        return 'Arclight is not set up for this yet (TMDB is not configured).';
      default:
        return `Could not do that: ${err.message}.`;
    }
  }
  return 'Something went wrong; try again later.';
}

export function requestEmbed(r: MediaRequest, heading: string, colour: number = COLOURS.info): DiscordEmbed {
  const embed: DiscordEmbed = {
    title: `${heading}: ${r.mediaTitle}${r.mediaYear ? ` (${r.mediaYear})` : ''}`,
    color: colour,
    fields: [
      { name: 'Type', value: `${r.type === 'movie' ? 'Movie' : 'Series'}${r.is4k ? ' (4K)' : ''}`, inline: true },
      { name: 'Requested by', value: r.requestedBy.displayName ?? r.requestedBy.username, inline: true },
      { name: 'Status', value: r.status, inline: true },
    ],
    footer: { text: `Request #${r.id}` },
  };
  if (r.seasons.length > 0) embed.fields!.push({ name: 'Seasons', value: r.seasons.map((s) => s.seasonNumber).join(', '), inline: false });
  if (r.mediaPoster) embed.thumbnail = { url: r.mediaPoster };
  return embed;
}

export const EMBED_COLOURS = COLOURS;
