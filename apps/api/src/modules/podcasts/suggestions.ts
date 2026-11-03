import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import { Permission, redactFeedUrl, type CreatePodcastSuggestion, type PodcastSuggestion, type PodcastSuggestionListQuery } from '@arclight/shared';
import { PodcastSuggestionListQuery as ListQuerySchema } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { canAutoApproveAudio, canManageRequests, canSuggestPodcast, requestTypeAllowed } from '../requests/permissions.js';
import { podcastSuggestions, type PodcastSuggestionRow } from './schema.js';
import { PodcastsError, sameFeedUrl, type PodcastsService } from './service.js';

// Podcast suggestions from the request portal. Anyone who may request music or audiobooks (or
// anything at all) may suggest a podcast, unless their request-type filter turns podcasts off.
// The feed must parse; an admin (or request manager) approves it, which subscribes with the
// default podcast settings. Users who may auto-approve are subscribed straight away.

export interface SuggestionActor {
  userId: number | null;
  permissions: number;
}

const isAdmin = (held: number) => (held & Permission.ADMIN) !== 0;

export class PodcastSuggestions {
  private readonly now: () => Date;

  constructor(
    private readonly opts: {
      db: Db;
      podcasts: PodcastsService;
      log?: Logger;
      now?: () => Date;
      publish?: (id: number) => void;
    },
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  private get db(): Db {
    return this.opts.db;
  }

  private toSuggestion(row: PodcastSuggestionRow, username: string, actor: SuggestionActor): PodcastSuggestion {
    return {
      id: row.id,
      userId: row.userId,
      username,
      feedUrl: isAdmin(actor.permissions) ? row.feedUrl : redactFeedUrl(row.feedUrl),
      title: row.title,
      author: row.author,
      imageUrl: row.imageUrl,
      itunesId: row.itunesId,
      podcastIndexId: row.podcastIndexId,
      note: row.note,
      status: row.status,
      podcastId: row.podcastId,
      declineReason: row.declineReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private one(id: number, actor: SuggestionActor): PodcastSuggestion {
    const r = this.db
      .select({ s: podcastSuggestions, username: users.username })
      .from(podcastSuggestions)
      .innerJoin(users, eq(podcastSuggestions.userId, users.id))
      .where(eq(podcastSuggestions.id, id))
      .get();
    if (!r) throw new PodcastsError('NOT_FOUND', `podcast suggestion ${id} not found`);
    return this.toSuggestion(r.s, r.username, actor);
  }

  /** Managers see everyone's suggestions (unless `mine`); everyone else only their own. */
  list(actor: SuggestionActor, input: PodcastSuggestionListQuery = {}): PodcastSuggestion[] {
    const q = ListQuerySchema.parse(input);
    const conds: SQL[] = [];
    const manager = canManageRequests(actor.permissions);
    if (!manager || q.mine) {
      if (actor.userId === null) return [];
      conds.push(eq(podcastSuggestions.userId, actor.userId));
    }
    if (q.status) conds.push(eq(podcastSuggestions.status, q.status));
    return this.db
      .select({ s: podcastSuggestions, username: users.username })
      .from(podcastSuggestions)
      .innerJoin(users, eq(podcastSuggestions.userId, users.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(podcastSuggestions.createdAt), desc(podcastSuggestions.id))
      .all()
      .map((r) => this.toSuggestion(r.s, r.username, actor));
  }

  /** Check the caller may suggest podcasts at all (permission bits and request-type filter). */
  assertMaySuggest(actor: SuggestionActor): void {
    if (actor.userId === null) throw new PodcastsError('FORBIDDEN', 'podcast suggestions need a signed-in user');
    if (!canSuggestPodcast(actor.permissions)) throw new PodcastsError('FORBIDDEN', 'you are not allowed to make requests');
    const user = this.db.select().from(users).where(eq(users.id, actor.userId)).get();
    if (!user) throw new PodcastsError('FORBIDDEN', 'unknown user');
    if (!requestTypeAllowed({ permissions: actor.permissions, settings: user.settings }, 'podcast')) {
      throw new PodcastsError('FORBIDDEN', 'podcast requests are turned off for this user');
    }
  }

  async create(actor: SuggestionActor, input: CreatePodcastSuggestion): Promise<PodcastSuggestion> {
    this.assertMaySuggest(actor);
    // Suggestions reach public hosts only, and a failure comes back as one generic message, so
    // the preview cannot be used to probe the server's network (DATA-06).
    const preview = await this.opts.podcasts.preview(input.feedUrl).catch((err: unknown) => {
      if (err instanceof PodcastsError && err.code === 'FEED') throw new PodcastsError('FEED', 'that address could not be read as a podcast feed');
      throw err;
    });
    if (preview.podcastId !== null) throw new PodcastsError('CONFLICT', `${preview.title} is already in the library`);
    const pending = this.db.select().from(podcastSuggestions).where(eq(podcastSuggestions.status, 'pending')).all();
    const dup = pending.find((p) => sameFeedUrl(p.feedUrl, input.feedUrl) || (input.itunesId != null && p.itunesId === input.itunesId));
    if (dup) throw new PodcastsError('CONFLICT', `${dup.title} has already been suggested`);

    const at = this.now().toISOString();
    const row = this.db
      .insert(podcastSuggestions)
      .values({
        userId: actor.userId!,
        feedUrl: input.feedUrl,
        title: preview.title,
        author: preview.author,
        imageUrl: preview.imageUrl,
        itunesId: input.itunesId ?? null,
        podcastIndexId: input.podcastIndexId ?? null,
        note: input.note?.trim() || null,
        status: 'pending',
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    this.opts.log?.info({ suggestionId: row.id, userId: actor.userId, feed: redactFeedUrl(input.feedUrl) }, 'podcast suggested');
    this.opts.publish?.(row.id);
    if (canAutoApproveAudio(actor.permissions)) {
      try {
        return await this.approve({ userId: actor.userId, permissions: actor.permissions | Permission.MANAGE_REQUESTS }, row.id, actor);
      } catch (err) {
        // The suggestion stays pending for an admin (no root folder yet, feed hiccup).
        this.opts.log?.warn({ suggestionId: row.id, err: err instanceof Error ? err.message : String(err) }, 'podcast suggestion auto-approve failed');
      }
    }
    return this.one(row.id, actor);
  }

  /** Subscribe to the suggested feed. */
  async approve(actor: SuggestionActor, id: number, viewer: SuggestionActor = actor): Promise<PodcastSuggestion> {
    if (!canManageRequests(actor.permissions)) throw new PodcastsError('FORBIDDEN', 'only request managers can approve suggestions');
    const row = this.db.select().from(podcastSuggestions).where(eq(podcastSuggestions.id, id)).get();
    if (!row) throw new PodcastsError('NOT_FOUND', `podcast suggestion ${id} not found`);
    if (row.status === 'approved') return this.one(id, viewer);
    let podcastId: number;
    try {
      const p = await this.opts.podcasts.add({
        feedUrl: row.feedUrl,
        ...(row.itunesId !== null ? { itunesId: row.itunesId } : {}),
        ...(row.podcastIndexId !== null ? { podcastIndexId: row.podcastIndexId } : {}),
      });
      podcastId = p.id;
    } catch (err) {
      // Someone subscribed in the meantime: link to that podcast.
      if (!(err instanceof PodcastsError && err.code === 'CONFLICT')) throw err;
      const existing = this.opts.podcasts.list().find((p) => sameFeedUrl(p.feedUrl, redactFeedUrl(row.feedUrl)) || (row.itunesId !== null && p.itunesId === row.itunesId));
      if (!existing) throw err;
      podcastId = existing.id;
    }
    this.db
      .update(podcastSuggestions)
      .set({ status: 'approved', podcastId, declineReason: null, updatedAt: this.now().toISOString() })
      .where(eq(podcastSuggestions.id, id))
      .run();
    this.opts.publish?.(id);
    return this.one(id, viewer);
  }

  decline(actor: SuggestionActor, id: number, reason?: string): PodcastSuggestion {
    if (!canManageRequests(actor.permissions)) throw new PodcastsError('FORBIDDEN', 'only request managers can decline suggestions');
    const row = this.db.select().from(podcastSuggestions).where(eq(podcastSuggestions.id, id)).get();
    if (!row) throw new PodcastsError('NOT_FOUND', `podcast suggestion ${id} not found`);
    this.db
      .update(podcastSuggestions)
      .set({ status: 'declined', declineReason: reason?.trim() || null, updatedAt: this.now().toISOString() })
      .where(eq(podcastSuggestions.id, id))
      .run();
    this.opts.publish?.(id);
    return this.one(id, actor);
  }

  /** Managers delete any suggestion; users withdraw their own pending ones. */
  remove(actor: SuggestionActor, id: number): void {
    const row = this.db.select().from(podcastSuggestions).where(eq(podcastSuggestions.id, id)).get();
    if (!row) throw new PodcastsError('NOT_FOUND', `podcast suggestion ${id} not found`);
    const own = actor.userId !== null && row.userId === actor.userId;
    if (!canManageRequests(actor.permissions) && !(own && row.status === 'pending')) {
      throw new PodcastsError('FORBIDDEN', 'you can only withdraw your own pending suggestions');
    }
    this.db.delete(podcastSuggestions).where(eq(podcastSuggestions.id, id)).run();
    this.opts.publish?.(id);
  }
}
