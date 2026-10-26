import { describe, expect, it } from 'vitest';
import { Permission as P } from '@arclight/shared';
import { mediaRequests, seasonRequests } from './schema.js';
import { effectiveQuota, quotaFor, quotaInfo, quotaOverrides } from './quota.js';
import { addUser, NOW, setup } from './test-support.js';
import type { Db } from '../../db/index.js';

const DAY = 24 * 60 * 60 * 1000;

function insertRequest(
  db: Db,
  userId: number,
  opts: { type?: 'movie' | 'series'; status?: 'pending' | 'approved' | 'declined' | 'completed' | 'failed'; daysAgo?: number; seasons?: number[]; ignoreQuota?: boolean; tmdbId?: number },
): number {
  const created = new Date(NOW.getTime() - (opts.daysAgo ?? 0) * DAY).toISOString();
  const row = db
    .insert(mediaRequests)
    .values({
      type: opts.type ?? 'movie',
      status: opts.status ?? 'approved',
      tmdbId: opts.tmdbId ?? Math.floor(Math.random() * 1e6),
      title: 't',
      requestedById: userId,
      tags: [],
      ignoreQuota: opts.ignoreQuota ?? false,
      createdAt: created,
      updatedAt: created,
    })
    .returning()
    .get();
  for (const n of opts.seasons ?? []) db.insert(seasonRequests).values({ requestId: row.id, seasonNumber: n, status: 'approved' }).run();
  return row.id;
}

describe('quota math', () => {
  it('computes remaining and restricted; 0 or null limits are unlimited', () => {
    expect(quotaInfo(5, 7, 2)).toEqual({ days: 7, limit: 5, used: 2, remaining: 3, restricted: false });
    expect(quotaInfo(2, 30, 2).restricted).toBe(true);
    expect(quotaInfo(2, 30, 5).remaining).toBe(0);
    expect(quotaInfo(0, 7, 9)).toEqual({ days: 7, limit: null, used: 9, remaining: null, restricted: false });
    expect(quotaInfo(null, null, 1).days).toBeNull();
  });

  it('user overrides replace defaults field by field', () => {
    const overrides = quotaOverrides({ quota: { movieLimit: 3, movieDays: null, tvLimit: null, tvDays: 14 } });
    expect(effectiveQuota(overrides, { movieLimit: 10, movieDays: 7, tvLimit: 5, tvDays: 7 })).toEqual({ movieLimit: 3, movieDays: 7, tvLimit: 5, tvDays: 14 });
    expect(quotaOverrides({ quota: 'garbage' })).toEqual({ movieLimit: null, movieDays: null, tvLimit: null, tvDays: null });
  });
});

describe('quota usage', () => {
  it('counts movie requests in the window, skipping declined and ignoreQuota ones', async () => {
    const { db } = await setup();
    const u = addUser(db);
    insertRequest(db, u.id, { daysAgo: 1 });
    insertRequest(db, u.id, { daysAgo: 2, status: 'completed' });
    insertRequest(db, u.id, { daysAgo: 3, status: 'failed' });
    insertRequest(db, u.id, { daysAgo: 1, status: 'declined' });
    insertRequest(db, u.id, { daysAgo: 1, ignoreQuota: true });
    insertRequest(db, u.id, { daysAgo: 40 });
    const q = quotaFor(db, { id: u.id, permissions: P.REQUEST, settings: {} }, { movieLimit: 5, movieDays: 30, tvLimit: null, tvDays: null }, NOW);
    expect(q.status.movie).toMatchObject({ used: 3, remaining: 2, restricted: false });
  });

  it('series usage is the number of requested seasons (spec example: 2 used of 5 per 7 days)', async () => {
    const { db } = await setup();
    const u = addUser(db);
    insertRequest(db, u.id, { type: 'series', daysAgo: 1, seasons: [1, 2] });
    insertRequest(db, u.id, { type: 'series', daysAgo: 9, seasons: [3] });
    const q = quotaFor(db, { id: u.id, permissions: P.REQUEST, settings: {} }, { movieLimit: null, movieDays: null, tvLimit: 5, tvDays: 7 }, NOW);
    expect(q.status.series).toEqual({ days: 7, limit: 5, used: 2, remaining: 3, restricted: false });
  });

  it('days unset counts every request (lifetime)', async () => {
    const { db } = await setup();
    const u = addUser(db);
    insertRequest(db, u.id, { daysAgo: 400 });
    const q = quotaFor(db, { id: u.id, permissions: P.REQUEST, settings: {} }, { movieLimit: 1, movieDays: null, tvLimit: null, tvDays: null }, NOW);
    expect(q.status.movie.restricted).toBe(true);
  });

  it('MANAGE_USERS holders are exempt even with a limit', async () => {
    const { db } = await setup();
    const u = addUser(db, { permissions: P.MANAGE_USERS | P.REQUEST });
    insertRequest(db, u.id, {});
    const q = quotaFor(db, { id: u.id, permissions: P.MANAGE_USERS | P.REQUEST, settings: {} }, { movieLimit: 1, movieDays: 7, tvLimit: 1, tvDays: 7 }, NOW);
    expect(q.exempt).toBe(true);
    expect(q.status.movie).toMatchObject({ limit: null, restricted: false, used: 1 });
  });
});
