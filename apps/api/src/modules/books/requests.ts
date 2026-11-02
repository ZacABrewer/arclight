import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { BooksRequestListQuery, CreateBooksRequest, Permission, type BooksRequest, type BooksRequestList, type BooksRequestStatus } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { RequestsError } from '../requests/errors.js';
import { assertRequestTypeAllowed, can, canAutoApproveAudio, canManageRequests, canViewAllRequests, type Actor } from '../requests/permissions.js';
import { ownerUser, requestUsers, userRow, type UserRow } from '../requests/users.js';
import { parseBody } from './catalog.js';
import { BooksError } from './errors.js';
import { bookRequests, comicIssues, comicSeries, ebooks, type BookRequestRow } from './schema.js';

// Ebook and comic requests (docs/books.md "Requests"): portal users ask for a book (by
// catalogue key) or a comic series; managers approve or decline. Approving adds the book or
// series to the library and starts a search (the `fulfil` callback, wired in index.ts). The
// permission bits are the request system's: REQUEST to ask, AUTO_APPROVE / MANAGE_REQUESTS to
// skip review, MANAGE_REQUESTS to approve, decline and delete others' requests, plus the
// per-user request type filter (`ebook`, `comic`).
//
// `completed` is not stored: an approved request whose book (or any issue of the series) has
// a file reads as completed.

/** Adds the request's book / series to the library and searches; returns its library id. */
export type BooksRequestFulfiller = (request: BookRequestRow) => Promise<number>;

export class BooksRequestsService {
  constructor(private readonly deps: { db: Db; log: Logger; fulfil: BooksRequestFulfiller; now?: () => Date }) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private row(id: number): BookRequestRow {
    const row = this.deps.db.select().from(bookRequests).where(eq(bookRequests.id, id)).get();
    if (!row) throw BooksError.notFound('request', id);
    return row;
  }

  /** The user a request is filed for: API-key callers act through the owner account. */
  private requester(actor: Actor): UserRow {
    if (actor.anonymous) throw new BooksError('FORBIDDEN', 'sign in to request books');
    return actor.userId === null ? ownerUser(this.deps.db) : userRow(this.deps.db, actor.userId);
  }

  private available(rows: readonly BookRequestRow[]): Set<number> {
    const db = this.deps.db;
    const out = new Set<number>();
    const ebookIds = rows.filter((r) => r.kind === 'ebook' && r.libraryId !== null).map((r) => r.libraryId!);
    const seriesIds = rows.filter((r) => r.kind === 'comic' && r.libraryId !== null).map((r) => r.libraryId!);
    const haveBooks = new Set(
      ebookIds.length === 0 ? [] : db.select({ id: ebooks.id }).from(ebooks).where(and(inArray(ebooks.id, ebookIds), eq(ebooks.hasFile, true))).all().map((r) => r.id),
    );
    const haveSeries = new Set(
      seriesIds.length === 0
        ? []
        : db.select({ id: comicIssues.seriesId }).from(comicIssues).where(and(inArray(comicIssues.seriesId, seriesIds), eq(comicIssues.hasFile, true))).all().map((r) => r.id),
    );
    for (const r of rows) {
      if (r.libraryId === null) continue;
      if ((r.kind === 'ebook' && haveBooks.has(r.libraryId)) || (r.kind === 'comic' && haveSeries.has(r.libraryId))) out.add(r.id);
    }
    return out;
  }

  private toResources(actor: Actor, rows: readonly BookRequestRow[]): BooksRequest[] {
    const users = requestUsers(this.deps.db, rows.flatMap((r) => [r.requestedById, r.modifiedById]));
    const available = this.available(rows);
    const manage = canManageRequests(actor.permissions);
    return rows.map((r) => {
      const isAvailable = available.has(r.id);
      const status: BooksRequestStatus = r.status === 'approved' && isAvailable ? 'completed' : r.status;
      const by = users.get(r.requestedById) ?? { id: r.requestedById, username: `deleted user ${r.requestedById}` };
      const mod = r.modifiedById !== null ? (users.get(r.modifiedById) ?? { id: r.modifiedById, username: `deleted user ${r.modifiedById}` }) : null;
      return {
        id: r.id,
        kind: r.kind,
        status,
        foreignId: r.foreignId,
        title: r.title,
        subtitle: r.subtitle,
        year: r.year,
        coverUrl: r.coverUrl,
        requestedBy: { id: by.id, username: by.username },
        modifiedBy: mod ? { id: mod.id, username: mod.username } : null,
        declineReason: r.declineReason,
        failureReason: r.failureReason,
        libraryId: r.libraryId,
        available: isAvailable,
        canRemove: manage || (r.status === 'pending' && actor.userId !== null && r.requestedById === actor.userId),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  list(actor: Actor, raw: unknown): BooksRequestList {
    if (actor.anonymous) throw new BooksError('FORBIDDEN', 'sign in to see requests');
    const q = parseBody(BooksRequestListQuery, raw ?? {});
    const where: SQL[] = [];
    if (q.kind !== 'all') where.push(eq(bookRequests.kind, q.kind));
    // `completed` is an approved request whose item has a file (filtered after mapping).
    if (q.status !== 'all') where.push(eq(bookRequests.status, q.status === 'completed' ? 'approved' : q.status));
    const mineOnly = q.mine === true || !canViewAllRequests(actor.permissions);
    if (mineOnly) where.push(eq(bookRequests.requestedById, this.requester(actor).id));
    const rows = this.deps.db
      .select()
      .from(bookRequests)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(bookRequests.createdAt), desc(bookRequests.id))
      .all();
    let records = this.toResources(actor, rows);
    if (q.status === 'completed') records = records.filter((r) => r.status === 'completed');
    else if (q.status === 'approved') records = records.filter((r) => r.status === 'approved');
    return { records };
  }

  get(actor: Actor, id: number): BooksRequest {
    const row = this.row(id);
    if (!canViewAllRequests(actor.permissions) && (actor.anonymous || (actor.userId !== null && row.requestedById !== actor.userId))) throw BooksError.notFound('request', id);
    return this.toResources(actor, [row])[0]!;
  }

  /** Files a request; callers who may auto-approve get it approved (and fulfilled) at once. */
  async create(actor: Actor, raw: unknown): Promise<BooksRequest> {
    const req = parseBody(CreateBooksRequest, raw);
    const user = this.requester(actor);
    if (!can(actor.permissions, Permission.REQUEST, Permission.MANAGE_REQUESTS)) throw new BooksError('FORBIDDEN', 'you do not have permission to request books');
    try {
      assertRequestTypeAllowed({ permissions: actor.permissions, settings: actor.userId === null ? null : user.settings }, req.kind);
    } catch (err) {
      if (err instanceof RequestsError) throw new BooksError('FORBIDDEN', err.message);
      throw err;
    }
    const db = this.deps.db;
    const open = db
      .select({ id: bookRequests.id })
      .from(bookRequests)
      .where(and(eq(bookRequests.kind, req.kind), eq(bookRequests.foreignId, req.foreignId), inArray(bookRequests.status, ['pending', 'approved'])))
      .get();
    if (open) throw new BooksError('CONFLICT', `${req.title} has already been requested`);
    if (this.inLibrary(req.kind, req.foreignId)) throw new BooksError('CONFLICT', `${req.title} is already in the library`);
    const at = this.now();
    const row = db
      .insert(bookRequests)
      .values({ kind: req.kind, status: 'pending', foreignId: req.foreignId, title: req.title, subtitle: req.subtitle, year: req.year, coverUrl: req.coverUrl, requestedById: user.id, createdAt: at, updatedAt: at })
      .returning()
      .get();
    if (canAutoApproveAudio(actor.permissions)) return this.approveRow(actor, row, user.id);
    return this.toResources(actor, [row])[0]!;
  }

  private inLibrary(kind: BookRequestRow['kind'], foreignId: string): boolean {
    const db = this.deps.db;
    if (kind === 'comic') return db.select({ id: comicSeries.id }).from(comicSeries).where(eq(comicSeries.foreignId, foreignId)).get() !== undefined;
    if (db.select({ id: ebooks.id }).from(ebooks).where(eq(ebooks.foreignId, foreignId)).get()) return true;
    return db
      .select({ keys: ebooks.keys })
      .from(ebooks)
      .all()
      .some((r) => r.keys.includes(foreignId));
  }

  private async approveRow(actor: Actor, row: BookRequestRow, modifiedById: number): Promise<BooksRequest> {
    const db = this.deps.db;
    db.update(bookRequests).set({ status: 'approved', modifiedById, failureReason: null, updatedAt: this.now() }).where(eq(bookRequests.id, row.id)).run();
    try {
      const libraryId = await this.deps.fulfil(this.row(row.id));
      db.update(bookRequests).set({ libraryId, updatedAt: this.now() }).where(eq(bookRequests.id, row.id)).run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.warn({ id: row.id, err: message }, 'book request could not be fulfilled');
      db.update(bookRequests).set({ status: 'failed', failureReason: message, updatedAt: this.now() }).where(eq(bookRequests.id, row.id)).run();
    }
    return this.toResources(actor, [this.row(row.id)])[0]!;
  }

  private manager(actor: Actor): number {
    if (!canManageRequests(actor.permissions)) throw new BooksError('FORBIDDEN', 'you do not have permission to manage requests');
    return this.requester(actor).id;
  }

  /** Pending, declined or failed requests can be approved (a failed one is retried). */
  async approve(actor: Actor, id: number): Promise<BooksRequest> {
    const by = this.manager(actor);
    const row = this.row(id);
    if (row.status === 'approved') throw new BooksError('CONFLICT', 'the request is already approved');
    return this.approveRow(actor, row, by);
  }

  decline(actor: Actor, id: number, reason?: string): BooksRequest {
    const by = this.manager(actor);
    const row = this.row(id);
    if (row.status !== 'pending') throw new BooksError('CONFLICT', `only pending requests can be declined (this one is ${row.status})`);
    this.deps.db
      .update(bookRequests)
      .set({ status: 'declined', modifiedById: by, declineReason: reason?.trim() || null, updatedAt: this.now() })
      .where(eq(bookRequests.id, id))
      .run();
    return this.toResources(actor, [this.row(id)])[0]!;
  }

  /** Managers delete any request; users their own pending ones. */
  delete(actor: Actor, id: number): void {
    const row = this.row(id);
    const own = !actor.anonymous && actor.userId !== null && row.requestedById === actor.userId && row.status === 'pending';
    if (!canManageRequests(actor.permissions) && !own) throw new BooksError('FORBIDDEN', 'you can only remove your own pending requests');
    this.deps.db.delete(bookRequests).where(eq(bookRequests.id, id)).run();
  }
}
