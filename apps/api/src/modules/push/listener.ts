import { and, eq, inArray } from 'drizzle-orm';
import { Permission, type PushPayload, type ServerEvent } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { issues, mediaRequests, users } from '../../db/schema.js';
import type { PushKind, PushService } from './service.js';

// Bus -> browser notifications, until the requests module calls pushServiceFor(ctx) itself:
//   request created (pending)        -> request managers           (pref `requests`)
//   request approved/declined/failed -> the requester              (pref `requests`)
//   request completed                -> the requester              (pref `availability`)
//   import imported                  -> requesters of that title   (pref `availability`)
//   issue created                    -> issue managers             (pref `issues`)
//   issue updated                    -> the reporter               (pref `issues`)

/** A request completing right after its file was imported is one notification, not two. */
const DEDUPE_MS = 10 * 60_000;

export interface PushListenerOptions {
  db: Db;
  bus: EventBus;
  push: PushService;
  log?: Logger;
  now?: () => number;
}

interface Delivery {
  userId: number;
  kind: PushKind;
  payload: PushPayload;
  /** Same key within DEDUPE_MS is sent once. */
  dedupeKey?: string;
}

function libraryUrl(type: 'series' | 'movie', id: number | null): string | undefined {
  if (id === null) return undefined;
  return type === 'series' ? `/library/series/${id}` : `/library/movie/${id}`;
}

function titleOf(row: { title: string; year: number | null }): string {
  return row.year ? `${row.title} (${row.year})` : row.title;
}

function userName(db: Db, id: number): string {
  const u = db.select({ username: users.username, displayName: users.displayName }).from(users).where(eq(users.id, id)).get();
  return u?.displayName ?? u?.username ?? 'Someone';
}

/** The deliveries one event causes (pure apart from database reads; exported for tests). */
export function deliveriesFor(db: Db, push: Pick<PushService, 'managers'>, event: ServerEvent): Delivery[] {
  if (event.type === 'request') {
    const r = db.select().from(mediaRequests).where(eq(mediaRequests.id, event.id)).get();
    if (!r) return [];
    const name = titleOf(r);
    switch (event.action) {
      case 'created':
        if (r.status !== 'pending') return [];
        return push
          .managers(Permission.MANAGE_REQUESTS)
          .filter((id) => id !== r.requestedById)
          .map((userId) => ({
            userId,
            kind: 'requests' as const,
            payload: { title: 'New request', body: `${userName(db, r.requestedById)} requested ${name}${r.is4k ? ' in 4K' : ''}.`, url: '/requests', tag: `request-${r.id}` },
          }));
      case 'approved':
        return [{ userId: r.requestedById, kind: 'requests', payload: { title: 'Request approved', body: `${name} was approved.`, url: '/requests/mine', tag: `request-${r.id}` } }];
      case 'declined':
        return [
          {
            userId: r.requestedById,
            kind: 'requests',
            payload: { title: 'Request declined', body: `${name} was declined${r.declineReason ? `: ${r.declineReason}` : '.'}`, url: '/requests/mine', tag: `request-${r.id}` },
          },
        ];
      case 'failed':
        return [
          {
            userId: r.requestedById,
            kind: 'requests',
            payload: { title: 'Request failed', body: `${name} could not be added${r.failureReason ? `: ${r.failureReason}` : '.'}`, url: '/requests/mine', tag: `request-${r.id}` },
          },
        ];
      case 'completed': {
        const url = libraryUrl(r.type, r.libraryId) ?? '/requests/mine';
        return [
          {
            userId: r.requestedById,
            kind: 'availability',
            payload: { title: 'Now available', body: `${name} is available.`, url, tag: `available-${r.type}-${r.libraryId ?? r.tmdbId}` },
            dedupeKey: `${r.requestedById}:${r.type}:${r.libraryId ?? `tmdb${r.tmdbId}`}`,
          },
        ];
      }
      default:
        return [];
    }
  }
  if (event.type === 'import') {
    if (event.action !== 'imported' || !event.mediaType || event.mediaId === undefined) return [];
    const mediaType = event.mediaType;
    const mediaId = event.mediaId;
    const rows = db
      .select()
      .from(mediaRequests)
      .where(and(eq(mediaRequests.type, mediaType), eq(mediaRequests.libraryId, mediaId), inArray(mediaRequests.status, ['approved', 'completed'])))
      .all();
    const seen = new Set<number>();
    const out: Delivery[] = [];
    for (const r of rows) {
      if (seen.has(r.requestedById)) continue;
      seen.add(r.requestedById);
      out.push({
        userId: r.requestedById,
        kind: 'availability',
        payload: {
          title: mediaType === 'movie' ? 'Now available' : 'New episode available',
          body: mediaType === 'movie' ? `${titleOf(r)} is available.` : `${titleOf(r)}: ${event.title}`,
          url: libraryUrl(mediaType, mediaId),
          tag: `available-${mediaType}-${mediaId}`,
        },
        dedupeKey: `${r.requestedById}:${mediaType}:${mediaId}`,
      });
    }
    return out;
  }
  if (event.type === 'issue') {
    const i = db.select().from(issues).where(eq(issues.id, event.id)).get();
    if (!i) return [];
    const name = titleOf(i);
    if (event.action === 'created') {
      return push
        .managers(Permission.MANAGE_ISSUES)
        .filter((id) => id !== i.createdById)
        .map((userId) => ({
          userId,
          kind: 'issues' as const,
          payload: { title: 'New issue', body: `${userName(db, i.createdById)} reported a ${i.type} issue on ${name}.`, url: `/issues/${i.id}`, tag: `issue-${i.id}` },
        }));
    }
    if (event.action === 'updated') {
      if (i.modifiedById !== null && i.modifiedById === i.createdById) return [];
      return [
        {
          userId: i.createdById,
          kind: 'issues',
          payload: { title: 'Issue updated', body: `Your issue on ${name} is ${i.status}.`, url: `/issues/${i.id}`, tag: `issue-${i.id}` },
        },
      ];
    }
  }
  return [];
}

/** Subscribe to the bus; returns the unsubscribe function. */
export function registerPushListener(opts: PushListenerOptions): () => void {
  const recent = new Map<string, number>();
  const now = opts.now ?? Date.now;
  return opts.bus.subscribe((event) => {
    if (event.type !== 'request' && event.type !== 'import' && event.type !== 'issue') return;
    let deliveries: Delivery[];
    try {
      deliveries = deliveriesFor(opts.db, opts.push, event);
    } catch (err) {
      opts.log?.warn({ err, event: event.type }, 'push listener could not read the event subject');
      return;
    }
    const t = now();
    for (const [key, at] of recent) if (t - at > DEDUPE_MS) recent.delete(key);
    for (const d of deliveries) {
      if (d.dedupeKey) {
        if (recent.has(d.dedupeKey)) continue;
        recent.set(d.dedupeKey, t);
      }
      opts.push.notify(d.userId, d.kind, d.payload).catch((err: unknown) => opts.log?.warn({ err }, 'push notification failed'));
    }
  });
}
