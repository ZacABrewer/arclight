import { describe, expect, it } from 'vitest';
import { Permission as P, RequestsSettings } from '@media-tron/shared';
import { notifications, users } from '../../db/schema.js';
import { setSection } from '../settings/service.js';
import { jellyfinAvailability, type MediaServerAvailability } from './media-server.js';
import { issues, mediaRequests, requestMediaStatus } from './schema.js';
import { addUser, giveMovieFile, giveSeasonFiles, NOW, setup } from './test-support.js';
import { eq } from 'drizzle-orm';

const SHOW = { tmdbId: 1399, title: 'Thrones', year: 2011, seasons: [0, 2, 2] };

async function approvedSeries(seasons: number[]) {
  const h = await setup();
  h.tmdb.addSeries(SHOW).addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
  const user = addUser(h.db, {
    permissions: P.REQUEST | P.AUTO_APPROVE | P.REQUEST_4K | P.AUTO_APPROVE_4K,
    settings: { notifications: { discordEnabled: true, discordWebhookUrl: 'https://d/me' } },
  });
  const out = await h.services.requests.create(user.actor, { mediaType: 'series', tmdbId: 1399, seasons });
  if (out.kind !== 'created') throw new Error('not created');
  return { ...h, user, request: out.request };
}

describe('RequestsStatusSync', () => {
  it('completes a movie request once the library has a file and notifies the requester', async () => {
    const h = await setup();
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const u = addUser(h.db, { permissions: P.REQUEST | P.AUTO_APPROVE, settings: { notifications: { discordEnabled: true, discordWebhookUrl: 'https://d/me' } } });
    const out = await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    if (out.kind !== 'created') throw new Error();
    expect(await h.services.requests.syncStatuses()).toMatch(/0 requests completed/);
    giveMovieFile(h.db, 603);
    expect(await h.services.requests.syncStatuses()).toMatch(/1 requests completed/);
    expect(h.services.requests.get(u.actor, out.request.id)).toMatchObject({ status: 'completed', mediaStatus: 'available' });
    expect(h.sent.map((s) => s.event.type)).toContain('requestAvailable');
    const cached = h.db.select().from(requestMediaStatus).where(eq(requestMediaStatus.tmdbId, 603)).get();
    expect(cached).toMatchObject({ status: 'available', lastSyncedAt: NOW.toISOString() });
  });

  it('marks finished seasons but keeps a series request open until every requested season is available', async () => {
    const h = await approvedSeries([1, 2]);
    giveSeasonFiles(h.db, 1399, 1);
    await h.services.requests.syncStatuses();
    let req = h.services.requests.get(h.user.actor, h.request.id);
    expect(req.status).toBe('approved');
    expect(req.seasons).toEqual([
      { seasonNumber: 1, status: 'completed' },
      { seasonNumber: 2, status: 'approved' },
    ]);
    expect(req.mediaStatus).toBe('partiallyAvailable');
    giveSeasonFiles(h.db, 1399, 2);
    await h.services.requests.syncStatuses();
    req = h.services.requests.get(h.user.actor, h.request.id);
    expect(req).toMatchObject({ status: 'completed', mediaStatus: 'available' });
  });

  it('a 4K request completes only with 2160p files', async () => {
    const h = await setup();
    setSection(h.db, 'requests', RequestsSettings.parse({ movie4k: { enabled: true } }));
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const u = addUser(h.db, { permissions: P.REQUEST_4K | P.AUTO_APPROVE_4K });
    const out = await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603, is4k: true });
    if (out.kind !== 'created') throw new Error();
    giveMovieFile(h.db, 603, 1080);
    await h.services.requests.syncStatuses();
    expect(h.services.requests.get(u.actor, out.request.id).status).toBe('approved');
    giveMovieFile(h.db, 603, 2160);
    await h.services.requests.syncStatuses();
    expect(h.services.requests.get(u.actor, out.request.id)).toMatchObject({ status: 'completed', mediaStatus: 'available' });
  });

  it('consults the media-server hook only when enabled in settings', async () => {
    const asked: number[] = [];
    const server: MediaServerAvailability = {
      name: 'fake',
      isAvailable: async (q) => {
        asked.push(q.tmdbId);
        return true;
      },
    };
    const h = await setup({ extra: { mediaServer: server } });
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const u = addUser(h.db, { permissions: P.REQUEST | P.AUTO_APPROVE });
    const out = await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    if (out.kind !== 'created') throw new Error();
    await h.services.requests.syncStatuses();
    expect(asked).toEqual([]);
    setSection(h.db, 'requests', RequestsSettings.parse({ useMediaServerAvailability: true }));
    await h.services.requests.syncStatuses();
    expect(asked).toEqual([603]);
    expect(h.services.requests.get(u.actor, out.request.id).status).toBe('completed');
  });

  it('removes rows of users that no longer exist', async () => {
    const h = await setup();
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const u = addUser(h.db);
    await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    await h.services.issues.create(addUser(h.db, { permissions: P.CREATE_ISSUES }).actor, { type: 'video', mediaType: 'movie', tmdbId: 603, message: 'x' });
    h.db.delete(users).where(eq(users.id, u.id)).run();
    expect(await h.services.requests.syncStatuses()).toMatch(/1 orphaned rows removed/);
    expect(h.db.select().from(mediaRequests).all()).toHaveLength(0);
    expect(h.db.select().from(issues).all()).toHaveLength(1);
  });
});

describe('Jellyfin availability hook', () => {
  it('asks enabled Jellyfin/Emby connections by provider id and treats errors as unknown', async () => {
    const h = await setup();
    const now = NOW.toISOString();
    const flags = {
      onGrab: false, onDownload: false, onUpgrade: false, onRename: false, onSeriesAdd: false, onMovieAdd: false, onSeriesDelete: false,
      onMovieDelete: false, onFileDelete: false, onHealthIssue: false, onHealthRestored: false, onApplicationUpdate: false,
      onManualInteractionRequired: false, includeHealthWarnings: false,
    };
    h.db.insert(notifications).values({ name: 'jf', implementation: 'jellyfin', enabled: true, ...flags, tags: [], settings: { host: 'jf.local', port: 8096, apiKey: 'k' }, addedAt: now, updatedAt: now }).run();
    const urls: string[] = [];
    let answer: unknown = { TotalRecordCount: 1 };
    const hook = jellyfinAvailability(h.db, async (url, init) => {
      urls.push(url);
      expect((init?.headers as Record<string, string>)['X-Emby-Token']).toBe('k');
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer), { status: 200 });
    });
    expect(await hook.isAvailable({ mediaType: 'movie', tmdbId: 603 })).toBe(true);
    expect(urls[0]).toContain('http://jf.local:8096/Items');
    expect(decodeURIComponent(urls[0]!)).toContain('AnyProviderIdEquals=Tmdb.603');
    answer = { TotalRecordCount: 0 };
    expect(await hook.isAvailable({ mediaType: 'series', tmdbId: 1, tvdbId: 2 })).toBe(false);
    answer = new Error('down');
    expect(await hook.isAvailable({ mediaType: 'movie', tmdbId: 603 })).toBeNull();
  });
});
