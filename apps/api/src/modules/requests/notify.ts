import { and, eq } from 'drizzle-orm';
import {
  createAgent,
  testEvent,
  type IssueInfo,
  type MediaInfo,
  type NotificationAgent,
  type NotificationAgentKind,
  type NotificationEvent,
  type RequestInfo,
  type RequestsDigestEvent,
} from '@arclight/notifications';
import { Permission, type UserNotificationTestResult, type UserNotificationTypes } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { movies, notifications, series, tags as tagTable } from '../../db/schema.js';
import { toMediaInfo } from '../notifications/index.js';
import { can } from './permissions.js';
import type { audioRequests, issues, mediaRequests } from './schema.js';
import { allUserRows, findUserRow, requestSettingsOf, userPermissions, type UserRow } from './users.js';

// Request and issue notifications (docs/spec/requests.md sections 12-13).
//
// Personal agents: every user may configure a Discord webhook, a Telegram chat id (sent
// through the bot of the first enabled Telegram connection) and an email address (sent with
// the SMTP settings of the first enabled email connection) in `settings.notifications`.
// System connections additionally receive every event through the notifications module's
// dispatcher, filtered there by each connection's onRequest*/onIssue* flags (sitewide
// notifications). The daily digest goes to system connections only.

type RequestRow = typeof mediaRequests.$inferSelect;
type AudioRequestRow = typeof audioRequests.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

export type RequestNoticeKind = 'created' | 'approved' | 'declined' | 'available';
export type IssueNoticeKind = 'created' | 'comment' | 'resolved' | 'reopened';

export type AgentFactory = (kind: NotificationAgentKind, settings: unknown) => NotificationAgent;

export interface RequestNotifierOptions {
  db: Db;
  log?: Logger;
  agentFactory?: AgentFactory;
  /** System-wide connections (notifications module). */
  systemDispatch?: (event: NotificationEvent) => Promise<unknown>;
  instanceName?: string;
  /** Public URL of this Arclight (read per event so a saved setting applies at once). */
  applicationUrl?: () => string | undefined;
  now?: () => Date;
}

/** One line of the notification log tests and the UI can inspect. */
export interface Delivery {
  userId: number;
  agent: 'discord' | 'telegram' | 'email';
  event: NotificationEvent['type'];
  ok: boolean;
  error?: string;
}

const TYPE_KEY: Record<RequestNoticeKind, keyof UserNotificationTypes> = {
  created: 'requestPending',
  approved: 'requestApproved',
  declined: 'requestDeclined',
  available: 'requestAvailable',
};

export class RequestNotifier {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly agentFactory: AgentFactory;
  private readonly systemDispatch: ((event: NotificationEvent) => Promise<unknown>) | undefined;
  private readonly instanceName: string;
  private readonly applicationUrl: () => string | undefined;
  private readonly now: () => Date;
  /** Last deliveries (bounded); for tests and diagnostics. */
  readonly deliveries: Delivery[] = [];

  constructor(opts: RequestNotifierOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.agentFactory = opts.agentFactory ?? ((kind, settings) => createAgent(kind, settings));
    this.systemDispatch = opts.systemDispatch;
    this.instanceName = opts.instanceName ?? 'Arclight';
    this.applicationUrl = opts.applicationUrl ?? (() => undefined);
    this.now = opts.now ?? (() => new Date());
  }

  /** Common event fields; `applicationUrl` only when configured. */
  private base(): { instanceName: string; timestamp: string; applicationUrl?: string } {
    const url = this.applicationUrl()?.trim();
    return { instanceName: this.instanceName, timestamp: this.now().toISOString(), ...(url ? { applicationUrl: url } : {}) };
  }

  // -------------------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------------------

  async request(kind: RequestNoticeKind, req: RequestRow, extra: { reason?: string } = {}): Promise<void> {
    const requester = findUserRow(this.db, req.requestedById);
    const info: RequestInfo = {
      id: req.id,
      requestedBy: {
        id: req.requestedById,
        username: requester?.displayName ?? requester?.username ?? `user ${req.requestedById}`,
        ...(requester?.avatar ? { avatar: requester.avatar } : {}),
        ...(requester?.email ? { email: requester.email } : {}),
      },
      status: kind === 'created' ? (req.status === 'approved' ? 'approved' : 'pending') : kind === 'declined' ? 'declined' : kind === 'available' ? 'available' : 'approved',
      ...(req.type === 'series' ? { seasons: this.seasonsOf(req) } : {}),
      is4k: req.is4k,
    };
    const base = { ...this.base(), media: this.mediaInfo(req) };
    let event: NotificationEvent;
    switch (kind) {
      case 'created':
        event = { ...base, type: 'requestCreated', request: info };
        break;
      case 'approved':
        event = { ...base, type: 'requestApproved', request: info };
        break;
      case 'available':
        event = { ...base, type: 'requestAvailable', request: info };
        break;
      case 'declined':
        event = { ...base, type: 'requestDeclined', request: info, ...(extra.reason ? { reason: extra.reason } : {}) };
        break;
    }
    const audience =
      kind === 'created'
        ? this.admins(Permission.MANAGE_REQUESTS).filter((u) => u.id !== req.requestedById)
        : requester
          ? [requester]
          : [];
    await this.fanOut(audience, event, TYPE_KEY[kind]);
  }

  /**
   * Music and audiobook requests: the same four events and audiences as video requests. They carry
   * no deep links (the web's `/requests/:id` pages are video requests), so `applicationUrl` is left out.
   */
  async audioRequest(kind: RequestNoticeKind, req: AudioRequestRow, extra: { reason?: string } = {}): Promise<void> {
    const requester = findUserRow(this.db, req.requestedById);
    const info: RequestInfo = {
      id: req.id,
      requestedBy: {
        id: req.requestedById,
        username: requester?.displayName ?? requester?.username ?? `user ${req.requestedById}`,
        ...(requester?.avatar ? { avatar: requester.avatar } : {}),
        ...(requester?.email ? { email: requester.email } : {}),
      },
      status: kind === 'created' ? (req.status === 'approved' ? 'approved' : 'pending') : kind === 'declined' ? 'declined' : kind === 'available' ? 'available' : 'approved',
    };
    const { applicationUrl: _url, ...base } = this.base();
    const music = req.kind === 'album' || req.kind === 'artist';
    // MediaInfo.title is the artist / author; the album or book rides alongside.
    const person = req.kind === 'album' || req.kind === 'book' ? (req.subtitle ?? req.title) : req.title;
    const media: MediaInfo = {
      id: 0,
      mediaType: music ? 'music' : 'audiobook',
      title: person,
      year: req.year ?? 0,
      tmdbId: 0,
      path: '',
      genres: [],
      tags: [],
      images: req.coverUrl ? [{ coverType: 'poster', url: req.coverUrl }] : [],
    };
    const parts =
      req.kind === 'album'
        ? { artist: { id: 0, name: person, ...(req.parentForeignId ? { mbArtistId: req.parentForeignId } : {}) }, album: { id: req.libraryId ?? 0, title: req.title, mbReleaseGroupId: req.foreignId } }
        : req.kind === 'artist'
          ? { artist: { id: req.libraryId ?? 0, name: req.title, mbArtistId: req.foreignId } }
          : req.kind === 'book'
            ? {
                author: { id: 0, name: person, ...(req.parentForeignId ? { asin: req.parentForeignId } : {}) },
                book: { id: req.libraryId ?? 0, title: req.title, narrators: [], asin: req.foreignId },
              }
            : { author: { id: req.libraryId ?? 0, name: req.title, asin: req.foreignId } };
    const common = { ...base, media, ...parts };
    let event: NotificationEvent;
    switch (kind) {
      case 'created':
        event = { ...common, type: 'requestCreated', request: info };
        break;
      case 'approved':
        event = { ...common, type: 'requestApproved', request: info };
        break;
      case 'available':
        event = { ...common, type: 'requestAvailable', request: info };
        break;
      case 'declined':
        event = { ...common, type: 'requestDeclined', request: info, ...(extra.reason ? { reason: extra.reason } : {}) };
        break;
    }
    const audience =
      kind === 'created'
        ? this.admins(Permission.MANAGE_REQUESTS).filter((u) => u.id !== req.requestedById)
        : requester
          ? [requester]
          : [];
    await this.fanOut(audience, event, TYPE_KEY[kind]);
  }

  async issue(kind: IssueNoticeKind, issue: IssueRow, opts: { actorId: number | null; firstMessage: string; comment?: string }): Promise<void> {
    const creator = findUserRow(this.db, issue.createdById);
    const actor = opts.actorId === null ? undefined : findUserRow(this.db, opts.actorId);
    const info: IssueInfo = {
      id: issue.id,
      issueType: issue.type,
      status: issue.status,
      reportedBy: { id: issue.createdById, username: creator?.displayName ?? creator?.username ?? `user ${issue.createdById}` },
      message: opts.firstMessage,
      ...(issue.problemSeason > 0 ? { problemSeason: issue.problemSeason } : {}),
      ...(issue.problemEpisode > 0 ? { problemEpisode: issue.problemEpisode } : {}),
      ...(opts.comment && actor ? { comment: { user: { id: actor.id, username: actor.displayName ?? actor.username }, message: opts.comment } } : {}),
      ...(kind === 'created' ? {} : { change: kind }),
    };
    const media = this.mediaInfoFor(issue.mediaType, issue.tmdbId, issue.title, issue.year, issue.poster);
    const base = { ...this.base(), media };
    const event: NotificationEvent =
      kind === 'created' ? { ...base, type: 'issueCreated', issue: info } : { ...base, type: 'issueUpdated', issue: info };

    const audience = this.admins(Permission.MANAGE_ISSUES).filter((u) => u.id !== opts.actorId);
    // The creator hears about activity on their issue unless they did it or already get the admin copy.
    if (kind !== 'created' && creator && creator.id !== opts.actorId && !can(userPermissions(creator), Permission.MANAGE_ISSUES)) {
      audience.push(creator);
    }
    await this.fanOut(audience, event, kind === 'created' ? 'issueCreated' : 'issueUpdated');
  }

  /** The admin digest: system connections only (their onRequestCreated/onIssueCreated flags decide). */
  async digest(content: Omit<RequestsDigestEvent, 'instanceName' | 'timestamp' | 'applicationUrl'>): Promise<void> {
    if (!this.systemDispatch) return;
    const event: RequestsDigestEvent = { ...this.base(), ...content };
    await this.systemDispatch(event).catch((err: unknown) => this.log?.warn({ err }, 'digest dispatch failed'));
  }

  /** Sends a test through each enabled personal agent of `userId`. */
  async testUser(userId: number): Promise<UserNotificationTestResult> {
    const user = findUserRow(this.db, userId);
    if (!user) return { results: [] };
    const event = testEvent(this.instanceName, this.now);
    const results: UserNotificationTestResult['results'] = [];
    for (const { agent, build } of this.agentsFor(user)) {
      try {
        await build().send(event);
        results.push({ agent, ok: true });
      } catch (err) {
        results.push({ agent, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { results };
  }

  // -------------------------------------------------------------------------------------
  // delivery
  // -------------------------------------------------------------------------------------

  private async fanOut(audience: UserRow[], event: NotificationEvent, typeKey: keyof UserNotificationTypes): Promise<void> {
    const jobs: Promise<void>[] = [];
    const seen = new Set<number>();
    for (const user of audience) {
      if (seen.has(user.id)) continue;
      seen.add(user.id);
      const settings = requestSettingsOf(user).notifications;
      if (!settings.types[typeKey]) continue;
      for (const { agent, build } of this.agentsFor(user)) {
        jobs.push(
          (async () => {
            try {
              await build().send(event);
              this.record({ userId: user.id, agent, event: event.type, ok: true });
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              this.log?.warn({ err, userId: user.id, agent, event: event.type }, 'personal notification failed');
              this.record({ userId: user.id, agent, event: event.type, ok: false, error });
            }
          })(),
        );
      }
    }
    if (this.systemDispatch) {
      jobs.push(
        this.systemDispatch(event).then(
          () => undefined,
          (err: unknown) => this.log?.warn({ err, event: event.type }, 'system notification dispatch failed'),
        ),
      );
    }
    await Promise.all(jobs);
  }

  private record(d: Delivery): void {
    this.deliveries.push(d);
    if (this.deliveries.length > 200) this.deliveries.splice(0, this.deliveries.length - 200);
  }

  private agentsFor(user: UserRow): Array<{ agent: Delivery['agent']; build: () => NotificationAgent }> {
    const s = requestSettingsOf(user).notifications;
    const out: Array<{ agent: Delivery['agent']; build: () => NotificationAgent }> = [];
    if (s.discordEnabled && s.discordWebhookUrl) {
      const webhookUrl = s.discordWebhookUrl;
      out.push({ agent: 'discord', build: () => this.agentFactory('discord', { webhookUrl }) });
    }
    if (s.telegramEnabled && s.telegramChatId) {
      const chatId = s.telegramChatId;
      out.push({
        agent: 'telegram',
        build: () => {
          const conn = this.connection('telegram');
          if (!conn) throw new Error('no enabled Telegram connection to send through');
          const { topicId: _topic, ...rest } = conn as Record<string, unknown>;
          return this.agentFactory('telegram', { ...rest, chatId, sendSilently: s.telegramSendSilently });
        },
      });
    }
    const email = s.email ?? user.email ?? undefined;
    if (s.emailEnabled && email) {
      out.push({
        agent: 'email',
        build: () => {
          const conn = this.connection('email');
          if (!conn) throw new Error('no enabled email connection to send through');
          return this.agentFactory('email', { ...conn, to: [email], cc: [], bcc: [] });
        },
      });
    }
    return out;
  }

  private connection(kind: 'telegram' | 'email'): Record<string, unknown> | undefined {
    return this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.implementation, kind), eq(notifications.enabled, true)))
      .orderBy(notifications.id)
      .limit(1)
      .get()?.settings;
  }

  private admins(flag: number): UserRow[] {
    return allUserRows(this.db).filter((u) => can(userPermissions(u), flag));
  }

  private seasonsOf(req: RequestRow): number[] {
    // Kept out of the hot path: one small query per notification.
    return (this.seasonLookup?.(req.id) ?? []).sort((a, b) => a - b);
  }

  /** Injected by the service so the notifier does not re-implement season queries. */
  seasonLookup: ((requestId: number) => number[]) | undefined;

  private mediaInfo(req: RequestRow): MediaInfo {
    return this.mediaInfoFor(req.type, req.tmdbId, req.title, req.year, req.poster);
  }

  private mediaInfoFor(type: 'series' | 'movie', tmdbId: number, title: string, year: number | null, poster: string | null): MediaInfo {
    const row =
      type === 'movie'
        ? this.db.select().from(movies).where(eq(movies.tmdbId, tmdbId)).get()
        : this.db.select().from(series).where(eq(series.tmdbId, tmdbId)).get();
    if (row) {
      const labels = this.db.select().from(tagTable).all();
      const tagLabels = row.tags.map((id) => labels.find((t) => t.id === id)?.label).filter((l): l is string => Boolean(l));
      return toMediaInfo(type, row, tagLabels);
    }
    return {
      id: 0,
      mediaType: type,
      title,
      year: year ?? 0,
      tmdbId,
      path: '',
      genres: [],
      tags: [],
      images: poster ? [{ coverType: 'poster', url: poster }] : [],
    };
  }
}
