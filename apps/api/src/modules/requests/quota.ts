import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { UserQuota, type QuotaInfo, type QuotaStatus, type UserQuotaResponse } from '@media-tron/shared';
import type { Db } from '../../db/index.js';
import { isQuotaExempt } from './permissions.js';
import { mediaRequests, seasonRequests } from './schema.js';

// Quotas (docs/spec/requests.md section 4). A request counts while it is not declined and
// not marked ignoreQuota; series requests cost one per requested season. The window is
// "created after now minus days"; days unset or 0 means a lifetime count.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The user's stored overrides (`settings.quota`), tolerant of missing or malformed data. */
export function quotaOverrides(settings: Record<string, unknown> | null | undefined): UserQuota {
  const parsed = UserQuota.safeParse(settings?.['quota'] ?? {});
  return parsed.success ? parsed.data : UserQuota.parse({});
}

export function effectiveQuota(overrides: UserQuota, defaults: UserQuota): UserQuota {
  return {
    movieLimit: overrides.movieLimit ?? defaults.movieLimit,
    movieDays: overrides.movieDays ?? defaults.movieDays,
    tvLimit: overrides.tvLimit ?? defaults.tvLimit,
    tvDays: overrides.tvDays ?? defaults.tvDays,
  };
}

/** Builds one QuotaInfo; limit 0/null means unlimited. */
export function quotaInfo(limit: number | null, days: number | null, used: number): QuotaInfo {
  const effectiveLimit = limit && limit > 0 ? limit : null;
  const remaining = effectiveLimit === null ? null : Math.max(0, effectiveLimit - used);
  return {
    days: days && days > 0 ? days : null,
    limit: effectiveLimit,
    used,
    remaining,
    restricted: effectiveLimit !== null && effectiveLimit - used <= 0,
  };
}

function windowStart(days: number | null, now: Date): string | null {
  if (!days || days <= 0) return null;
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

export function countMovieUsage(db: Db, userId: number, days: number | null, now: Date): number {
  const since = windowStart(days, now);
  const where = [
    eq(mediaRequests.requestedById, userId),
    eq(mediaRequests.type, 'movie'),
    ne(mediaRequests.status, 'declined'),
    eq(mediaRequests.ignoreQuota, false),
  ];
  if (since) where.push(gt(mediaRequests.createdAt, since));
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(mediaRequests)
    .where(and(...where))
    .get();
  return row?.n ?? 0;
}

export function countSeasonUsage(db: Db, userId: number, days: number | null, now: Date, excludeRequestId?: number): number {
  const since = windowStart(days, now);
  const where = [
    eq(mediaRequests.requestedById, userId),
    eq(mediaRequests.type, 'series'),
    ne(mediaRequests.status, 'declined'),
    eq(mediaRequests.ignoreQuota, false),
  ];
  if (since) where.push(gt(mediaRequests.createdAt, since));
  if (excludeRequestId !== undefined) where.push(ne(mediaRequests.id, excludeRequestId));
  const ids = db
    .select({ id: mediaRequests.id })
    .from(mediaRequests)
    .where(and(...where))
    .all()
    .map((r) => r.id);
  if (ids.length === 0) return 0;
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(seasonRequests)
    .where(inArray(seasonRequests.requestId, ids))
    .get();
  return row?.n ?? 0;
}

export interface QuotaSubject {
  id: number;
  permissions: number;
  settings: Record<string, unknown> | null | undefined;
}

export function quotaFor(db: Db, user: QuotaSubject, defaults: UserQuota, now: Date): UserQuotaResponse {
  const overrides = quotaOverrides(user.settings);
  const effective = effectiveQuota(overrides, defaults);
  const exempt = isQuotaExempt(user.permissions);
  const status: QuotaStatus = {
    movie: quotaInfo(exempt ? null : effective.movieLimit, effective.movieDays, countMovieUsage(db, user.id, effective.movieDays, now)),
    series: quotaInfo(exempt ? null : effective.tvLimit, effective.tvDays, countSeasonUsage(db, user.id, effective.tvDays, now)),
  };
  return { overrides, effective, exempt, status };
}
