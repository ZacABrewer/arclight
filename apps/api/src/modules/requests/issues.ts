import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { CreateIssue, IssueListQuery, type Issue, type IssueCount, type IssuePage, type IssueStatus } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { RequestsError } from './errors.js';
import type { RequestNotifier } from './notify.js';
import { type Actor, canCreateIssues, canManageIssues, canViewAllIssues } from './permissions.js';
import { issueComments, issues } from './schema.js';
import type { TitleSource } from './service.js';
import { libraryAvailability } from './status.js';
import { ownerUser, requestUsers, userRow } from './users.js';

// Issues (docs/spec/requests.md section 13): reports against a title with a comment thread,
// open/resolved status and admin notifications.

type IssueRow = typeof issues.$inferSelect;
type CommentRow = typeof issueComments.$inferSelect;

export interface IssuesServiceOptions {
  db: Db;
  bus: EventBus;
  log?: Logger;
  titles: TitleSource;
  notifier: RequestNotifier;
  now?: () => Date;
}

export class IssuesService {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly log: Logger | undefined;
  private readonly titles: TitleSource;
  private readonly notifier: RequestNotifier;
  private readonly now: () => Date;

  constructor(opts: IssuesServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.titles = opts.titles;
    this.notifier = opts.notifier;
    this.now = opts.now ?? (() => new Date());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private row(id: number): IssueRow {
    const row = this.db.select().from(issues).where(eq(issues.id, id)).get();
    if (!row) throw RequestsError.notFound('issue', id);
    return row;
  }

  private comments(issueIds: number[]): Map<number, CommentRow[]> {
    const out = new Map<number, CommentRow[]>();
    if (issueIds.length === 0) return out;
    for (const c of this.db.select().from(issueComments).where(inArray(issueComments.issueId, issueIds)).orderBy(asc(issueComments.id)).all()) {
      const list = out.get(c.issueId) ?? [];
      list.push(c);
      out.set(c.issueId, list);
    }
    return out;
  }

  private toResources(rows: IssueRow[]): Issue[] {
    if (rows.length === 0) return [];
    const comments = this.comments(rows.map((r) => r.id));
    const people = requestUsers(this.db, [
      ...rows.flatMap((r) => [r.createdById, r.modifiedById]),
      ...[...comments.values()].flat().map((c) => c.userId),
    ]);
    const libIds = new Map<string, number>();
    for (const type of ['movie', 'series'] as const) {
      for (const [tmdbId, entry] of libraryAvailability(this.db, type, rows.filter((r) => r.mediaType === type).map((r) => r.tmdbId))) {
        libIds.set(`${type}:${tmdbId}`, entry.libraryId);
      }
    }
    const who = (id: number) => people.get(id) ?? { id, username: `deleted user ${id}` };
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      mediaType: r.mediaType,
      mediaTmdbId: r.tmdbId,
      mediaTitle: r.title,
      mediaYear: r.year,
      mediaPoster: r.poster,
      libraryId: libIds.get(`${r.mediaType}:${r.tmdbId}`) ?? null,
      problemSeason: r.problemSeason,
      problemEpisode: r.problemEpisode,
      createdBy: who(r.createdById),
      modifiedBy: r.modifiedById === null ? null : who(r.modifiedById),
      comments: (comments.get(r.id) ?? []).map((c) => ({
        id: c.id,
        user: who(c.userId),
        message: c.message,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  private assertCanRead(actor: Actor): void {
    if (!canCreateIssues(actor.permissions) && !canViewAllIssues(actor.permissions)) throw RequestsError.forbidden();
  }

  private assertCanSee(actor: Actor, row: IssueRow): void {
    this.assertCanRead(actor);
    if (row.createdById !== actor.userId && !canViewAllIssues(actor.permissions)) throw RequestsError.forbidden();
  }

  private scope(actor: Actor, createdBy?: number): SQL | undefined {
    if (canViewAllIssues(actor.permissions)) return createdBy === undefined ? undefined : eq(issues.createdById, createdBy);
    if (createdBy !== undefined && createdBy !== actor.userId) throw RequestsError.forbidden('you may only view your own issues');
    return eq(issues.createdById, actor.userId ?? -1);
  }

  list(actor: Actor, raw: IssueListQuery): IssuePage {
    this.assertCanRead(actor);
    const q = IssueListQuery.parse(raw);
    const where: SQL[] = [];
    const scope = this.scope(actor, q.createdBy);
    if (scope) where.push(scope);
    if (q.filter !== 'all') where.push(eq(issues.status, q.filter));
    if (q.tmdbId !== undefined) where.push(eq(issues.tmdbId, q.tmdbId));
    if (q.mediaType !== undefined) where.push(eq(issues.mediaType, q.mediaType));
    if (q.type !== undefined) where.push(eq(issues.type, q.type));
    const rows = this.db
      .select()
      .from(issues)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(q.sort === 'modified' ? issues.updatedAt : issues.createdAt), desc(issues.id))
      .all();
    return { pageInfo: { total: rows.length, take: q.take, skip: q.skip }, results: this.toResources(rows.slice(q.skip, q.skip + q.take)) };
  }

  count(actor: Actor): IssueCount {
    this.assertCanRead(actor);
    const rows = this.db.select().from(issues).where(this.scope(actor)).all();
    const by = (type: IssueRow['type']) => rows.filter((r) => r.type === type).length;
    return {
      total: rows.length,
      video: by('video'),
      audio: by('audio'),
      subtitles: by('subtitles'),
      other: by('other'),
      open: rows.filter((r) => r.status === 'open').length,
      resolved: rows.filter((r) => r.status === 'resolved').length,
    };
  }

  /** Open issues on a title the actor may see (title pages). */
  openCount(actor: Actor, type: 'movie' | 'series', tmdbId: number): number {
    if (!canCreateIssues(actor.permissions) && !canViewAllIssues(actor.permissions)) return 0;
    const where = [eq(issues.mediaType, type), eq(issues.tmdbId, tmdbId), eq(issues.status, 'open')];
    const scope = this.scope(actor);
    if (scope) where.push(scope);
    return this.db.select({ id: issues.id }).from(issues).where(and(...where)).all().length;
  }

  get(actor: Actor, id: number): Issue {
    const row = this.row(id);
    this.assertCanSee(actor, row);
    return this.toResources([row])[0]!;
  }

  private async titleOf(type: 'movie' | 'series', tmdbId: number): Promise<{ title: string; year: number | null; poster: string | null }> {
    try {
      const client = this.titles.client();
      const meta = type === 'movie' ? await client.getMovie(tmdbId) : await client.getSeries(tmdbId);
      return { title: meta.title, year: meta.year ?? null, poster: meta.images.poster ?? null };
    } catch (err) {
      this.log?.debug({ err, tmdbId }, 'issue title lookup failed; using a placeholder');
      return { title: `${type === 'movie' ? 'Movie' : 'Series'} ${tmdbId}`, year: null, poster: null };
    }
  }

  async create(actor: Actor, raw: CreateIssue): Promise<Issue> {
    const input = CreateIssue.parse(raw);
    if (!canCreateIssues(actor.permissions)) throw RequestsError.forbidden('reporting issues needs Report issues');
    let creatorId: number;
    if (input.userId !== undefined && input.userId !== actor.userId) {
      if (!canManageIssues(actor.permissions)) throw RequestsError.forbidden('reporting for another user needs Manage issues');
      creatorId = userRow(this.db, input.userId).id;
    } else {
      creatorId = actor.userId ?? ownerUser(this.db).id;
    }
    const title = await this.titleOf(input.mediaType, input.tmdbId);
    const now = this.iso();
    const row = this.db
      .insert(issues)
      .values({
        type: input.type,
        status: 'open',
        mediaType: input.mediaType,
        tmdbId: input.tmdbId,
        ...title,
        problemSeason: input.problemSeason,
        problemEpisode: input.problemEpisode,
        createdById: creatorId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    this.db.insert(issueComments).values({ issueId: row.id, userId: creatorId, message: input.message, createdAt: now, updatedAt: now }).run();
    this.bus.publish({ type: 'issue', action: 'created', id: row.id });
    await this.notifier
      .issue('created', row, { actorId: creatorId, firstMessage: input.message })
      .catch((err: unknown) => this.log?.warn({ err }, 'issue notification failed'));
    return this.toResources([row])[0]!;
  }

  private firstMessage(issueId: number): string {
    return this.db.select().from(issueComments).where(eq(issueComments.issueId, issueId)).orderBy(asc(issueComments.id)).limit(1).get()?.message ?? '';
  }

  async comment(actor: Actor, id: number, message: string): Promise<Issue> {
    const row = this.row(id);
    const own = row.createdById === actor.userId;
    if (!canManageIssues(actor.permissions) && !(own && canCreateIssues(actor.permissions))) throw RequestsError.forbidden();
    const authorId = actor.userId ?? ownerUser(this.db).id;
    const now = this.iso();
    this.db.insert(issueComments).values({ issueId: id, userId: authorId, message, createdAt: now, updatedAt: now }).run();
    const updated = this.db.update(issues).set({ updatedAt: now }).where(eq(issues.id, id)).returning().get()!;
    this.bus.publish({ type: 'issue', action: 'updated', id });
    await this.notifier
      .issue('comment', updated, { actorId: authorId, firstMessage: this.firstMessage(id), comment: message })
      .catch((err: unknown) => this.log?.warn({ err }, 'issue notification failed'));
    return this.toResources([updated])[0]!;
  }

  editComment(actor: Actor, commentId: number, message: string): Issue {
    const comment = this.db.select().from(issueComments).where(eq(issueComments.id, commentId)).get();
    if (!comment) throw RequestsError.notFound('comment', commentId);
    if (comment.userId !== actor.userId) throw RequestsError.forbidden('only the author can edit a comment');
    this.db.update(issueComments).set({ message, updatedAt: this.iso() }).where(eq(issueComments.id, commentId)).run();
    this.bus.publish({ type: 'issue', action: 'updated', id: comment.issueId });
    return this.toResources([this.row(comment.issueId)])[0]!;
  }

  deleteComment(actor: Actor, commentId: number): void {
    const comment = this.db.select().from(issueComments).where(eq(issueComments.id, commentId)).get();
    if (!comment) throw RequestsError.notFound('comment', commentId);
    if (comment.userId !== actor.userId && !canManageIssues(actor.permissions)) throw RequestsError.forbidden();
    this.db.delete(issueComments).where(eq(issueComments.id, commentId)).run();
    this.bus.publish({ type: 'issue', action: 'updated', id: comment.issueId });
  }

  async setStatus(actor: Actor, id: number, status: IssueStatus): Promise<Issue> {
    const row = this.row(id);
    if (row.createdById !== actor.userId && !canManageIssues(actor.permissions)) throw RequestsError.forbidden();
    if (row.status === status) return this.toResources([row])[0]!;
    const updated = this.db
      .update(issues)
      .set({ status, modifiedById: actor.userId, updatedAt: this.iso() })
      .where(eq(issues.id, id))
      .returning()
      .get()!;
    this.bus.publish({ type: 'issue', action: 'updated', id });
    await this.notifier
      .issue(status === 'resolved' ? 'resolved' : 'reopened', updated, { actorId: actor.userId, firstMessage: this.firstMessage(id) })
      .catch((err: unknown) => this.log?.warn({ err }, 'issue notification failed'));
    return this.toResources([updated])[0]!;
  }

  remove(actor: Actor, id: number): void {
    const row = this.row(id);
    if (!canManageIssues(actor.permissions)) {
      const comments = this.db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, id)).all().length;
      if (row.createdById !== actor.userId || comments > 1) throw RequestsError.forbidden('only issues of your own without replies can be deleted');
    }
    this.db.delete(issues).where(eq(issues.id, id)).run();
    this.bus.publish({ type: 'issue', action: 'deleted', id });
  }
}
