import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotificationEvent } from '@arclight/notifications';
import { Permission } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { setSection } from '../settings/service.js';
import type { Transport } from './http.js';
import { podcastEpisodes, podcasts } from './schema.js';
import { PodcastsError, PodcastsService } from './service.js';
import { PodcastSuggestions } from './suggestions.js';
import { transportFor } from './http.js';
import type { TagRequest, Tagger } from './tagger.js';

// Service flows against an in-memory database, a temp podcast root and a scripted transport.
// No network: every URL the service asks for is answered by `routes`.

interface Item {
  guid: string;
  title: string;
  date: string;
  url?: string;
  extra?: string;
}

function feedXml(title: string, items: Item[], channelExtra = ''): string {
  const body = items
    .map(
      (i) => `<item><title>${i.title}</title><guid>${i.guid}</guid><pubDate>${new Date(i.date).toUTCString()}</pubDate>
<enclosure url="${i.url ?? `https://cdn.example.com/${i.guid}.mp3`}" length="10" type="audio/mpeg"/>${i.extra ?? ''}</item>`,
    )
    .join('\n');
  return `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel><title>${title}</title><itunes:author>Example Studios</itunes:author><itunes:image href="https://example.com/art.jpg"/>${channelExtra}
${body}</channel></rss>`;
}

type Route = (headers: Record<string, string>) => Response;
const ok = (body: string | Uint8Array, headers: Record<string, string> = {}): Route => () => new Response(body, { status: 200, headers });

const FEED = 'https://feeds.example.com/show.xml';
const EPISODES: Item[] = [
  { guid: 'e1', title: 'One', date: '2025-01-01T10:00:00Z' },
  { guid: 'e2', title: 'Two', date: '2025-01-08T10:00:00Z' },
  { guid: 'e3', title: 'Three', date: '2025-01-15T10:00:00Z' },
  { guid: 'e4', title: 'Four', date: '2025-01-22T10:00:00Z' },
];

let db: Db;
let root: string;
let routes: Record<string, Route>;
let calls: { url: string; headers: Record<string, string> }[];
let events: NotificationEvent[];
let tagged: TagRequest[];
let refreshed: { path: string; type: string }[];
let now: Date;

const transport: Transport = async (url, init) => {
  calls.push({ url, headers: init.headers });
  const route = routes[url];
  return route ? route(init.headers) : new Response('not found', { status: 404 });
};

const tagger: Tagger = {
  async tag(req) {
    tagged.push(req);
    return true;
  },
};

function service(extra: Partial<ConstructorParameters<typeof PodcastsService>[0]> = {}): PodcastsService {
  return new PodcastsService({
    db,
    now: () => now,
    transport: () => transport,
    tagger,
    notify: async (e) => {
      events.push(e);
    },
    refreshMediaServers: async (path, type) => {
      refreshed.push({ path, type });
    },
    ...extra,
  });
}

function episodesOf(id: number) {
  return db.select().from(podcastEpisodes).where(eq(podcastEpisodes.podcastId, id)).all();
}

beforeEach(async () => {
  db = await createTestDb();
  seedAdmin(db);
  root = await mkdtemp(join(tmpdir(), 'arclight-podcasts-'));
  setSection(db, 'podcasts', { rootFolder: root, defaults: { backlog: 2 } });
  routes = {
    [FEED]: ok(feedXml('The Show', EPISODES), { etag: '"v1"', 'content-type': 'application/rss+xml' }),
    'https://example.com/art.jpg': ok(new Uint8Array([0xff, 0xd8, 0xff]), { 'content-type': 'image/jpeg' }),
  };
  for (const e of EPISODES) routes[`https://cdn.example.com/${e.guid}.mp3`] = ok(new TextEncoder().encode(`audio ${e.guid}`), { 'content-type': 'audio/mpeg' });
  calls = [];
  events = [];
  tagged = [];
  refreshed = [];
  now = new Date('2025-01-23T00:00:00Z');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('subscribing', () => {
  it('needs a root folder', async () => {
    setSection(db, 'podcasts', { rootFolder: '' });
    await expect(service().add({ feedUrl: FEED })).rejects.toMatchObject({ code: 'NO_ROOT_FOLDER' });
  });

  it('stores the feed, knows every episode and queues the backlog', async () => {
    const p = await service().add({ feedUrl: FEED });
    expect(p).toMatchObject({ title: 'The Show', author: 'Example Studios', path: join(root, 'The Show'), monitored: true });
    const eps = episodesOf(p.id);
    expect(eps).toHaveLength(4);
    expect(eps.filter((e) => e.status === 'wanted').map((e) => e.guid).sort()).toEqual(['e3', 'e4']);
    expect(db.select().from(podcasts).get()!.etag).toBe('"v1"');
    // Subscribing never notifies about the back catalogue.
    expect(events).toHaveLength(0);
  });

  it('refuses a duplicate', async () => {
    const s = service();
    await s.add({ feedUrl: FEED });
    await expect(s.add({ feedUrl: FEED })).rejects.toBeInstanceOf(PodcastsError);
  });

  it('reports a broken feed as a FEED error', async () => {
    routes[FEED] = ok('<!DOCTYPE html><html><body>Not a feed</body></html>');
    await expect(service().add({ feedUrl: FEED })).rejects.toMatchObject({ code: 'FEED' });
  });

  it('keeps private feed credentials out of the API and sends them as Basic auth', async () => {
    const privateUrl = 'https://member:s3cret@feeds.example.com/show.xml';
    const p = await service().add({ feedUrl: privateUrl });
    expect(p.feedUrl).not.toContain('s3cret');
    expect(p.privateFeed).toBe(true);
    expect(calls[0]!.url).toBe(FEED);
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('member:s3cret').toString('base64')}`);
    expect(db.select().from(podcasts).get()!.feedUrl).toBe(privateUrl);
  });
});

describe('polling', () => {
  it('sends the validators and treats 304 as nothing new', async () => {
    const s = service();
    const p = await s.add({ feedUrl: FEED });
    routes[FEED] = (h) => (h['if-none-match'] === '"v1"' ? new Response(null, { status: 304 }) : new Response('unexpected', { status: 500 }));
    expect(await s.refresh(p.id)).toBe(0);
    expect(s.get(p.id).status).toBe('active');
  });

  it('adds new episodes, queues recent ones and notifies', async () => {
    const s = service();
    const p = await s.add({ feedUrl: FEED });
    const fresh: Item = { guid: 'e5', title: 'Five', date: '2025-01-29T10:00:00Z' };
    routes[FEED] = ok(feedXml('The Show', [...EPISODES, fresh]));
    expect(await s.refresh(p.id)).toBe(1);
    const e5 = episodesOf(p.id).find((e) => e.guid === 'e5')!;
    expect(e5.status).toBe('wanted');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'podcastEpisodes', podcast: { id: p.id, title: 'The Show' }, total: 1, items: [{ id: e5.id, title: 'Five' }] });
  });

  it('does not auto-download when the podcast says so', async () => {
    const s = service();
    const p = await s.add({ feedUrl: FEED, settings: { autoDownload: false } });
    routes[FEED] = ok(feedXml('The Show', [...EPISODES, { guid: 'e5', title: 'Five', date: '2025-01-29T10:00:00Z' }]));
    await s.refresh(p.id);
    expect(episodesOf(p.id).find((e) => e.guid === 'e5')!.status).toBe('available');
  });

  it('follows a permanent redirect and stores the new address', async () => {
    const s = service();
    const p = await s.add({ feedUrl: FEED });
    const moved = 'https://new.example.com/show.xml';
    routes[FEED] = () => new Response(null, { status: 301, headers: { location: moved } });
    routes[moved] = ok(feedXml('The Show', EPISODES));
    await s.refresh(p.id);
    expect(db.select().from(podcasts).get()!.feedUrl).toBe(moved);
  });

  it('moves to an <itunes:new-feed-url>', async () => {
    const s = service();
    const p = await s.add({ feedUrl: FEED });
    const moved = 'https://new.example.com/show.xml';
    routes[FEED] = ok(feedXml('The Show', EPISODES, `<itunes:new-feed-url>${moved}</itunes:new-feed-url>`));
    routes[moved] = ok(feedXml('The Show (new home)', EPISODES));
    await s.refresh(p.id);
    const row = db.select().from(podcasts).get()!;
    expect(row.feedUrl).toBe(moved);
    expect(row.title).toBe('The Show (new home)');
  });

  it('marks a 410 feed as gone and a failing one as error', async () => {
    const s = service();
    const p = await s.add({ feedUrl: FEED });
    routes[FEED] = () => new Response('', { status: 500 });
    await s.refresh(p.id);
    expect(s.get(p.id)).toMatchObject({ status: 'error' });
    routes[FEED] = () => new Response('', { status: 410 });
    await s.refresh(p.id);
    expect(s.get(p.id).status).toBe('gone');
  });

  it('polls only feeds that are due', async () => {
    const s = service();
    await s.add({ feedUrl: FEED });
    calls = [];
    await s.refreshDue();
    expect(calls).toHaveLength(0);
    now = new Date(now.getTime() + 2 * 60 * 60_000);
    await s.refreshDue();
    expect(calls.map((c) => c.url)).toEqual([FEED]);
  });
});

describe('downloading', () => {
  it('writes the file under Podcast/Year/Date - Title, the cover, chapters and transcripts, then tags and notifies', async () => {
    const ch = 'https://example.com/ch.json';
    const tr = 'https://example.com/tr.vtt';
    routes[FEED] = ok(
      feedXml('The Show', [
        {
          guid: 'p20',
          title: 'Part 1/2',
          date: '2025-01-20T10:00:00Z',
          extra: `<podcast:chapters url="${ch}" type="application/json+chapters"/><podcast:transcript url="${tr}" type="text/vtt" language="en"/>`,
        },
      ]),
    );
    routes['https://cdn.example.com/p20.mp3'] = ok(new TextEncoder().encode('audio p20'));
    routes[ch] = ok(JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 0, title: 'Intro' }, { startTime: 60, title: 'Main' }] }));
    routes[tr] = ok('WEBVTT\n\n00:00.000 --> 00:01.000\nHello');
    const s = service();
    const p = await s.add({ feedUrl: FEED });
    expect(await s.downloadWanted()).toBe('1 downloaded, 0 failed');

    const file = join(root, 'The Show', '2025', '2025-01-20 - Part 1-2.mp3');
    expect(await readFile(file, 'utf8')).toBe('audio p20');
    expect((await readdir(join(root, 'The Show'))).sort()).toEqual(['2025', 'cover.jpg']);
    expect(JSON.parse(await readFile(join(root, 'The Show', '2025', '2025-01-20 - Part 1-2.chapters.json'), 'utf8')).chapters).toHaveLength(2);
    expect(await readFile(join(root, 'The Show', '2025', '2025-01-20 - Part 1-2.en.vtt'), 'utf8')).toContain('Hello');

    const ep = episodesOf(p.id)[0]!;
    expect(ep).toMatchObject({ status: 'downloaded', path: file, sizeBytes: 9, hasChapters: true, transcriptFiles: ['2025-01-20 - Part 1-2.en.vtt'] });
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toMatchObject({ file, tags: { title: 'Part 1/2', podcast: 'The Show' }, coverFile: join(root, 'The Show', 'cover.jpg') });
    expect(tagged[0]!.chapters.map((c) => c.title)).toEqual(['Intro', 'Main']);
    expect(refreshed).toContainEqual({ path: join(root, 'The Show'), type: 'Created' });
    expect(events.find((e) => e.type === 'podcastDownload')).toMatchObject({ item: { id: ep.id, title: 'Part 1/2' }, path: file, sizeBytes: 9 });
  });

  it('fails an episode after repeated errors and leaves no partial file', async () => {
    const s = service();
    const p = await s.add({ feedUrl: FEED, settings: { backlog: 1 } });
    routes['https://cdn.example.com/e4.mp3'] = () => new Response('nope', { status: 503 });
    for (let i = 0; i < 4; i += 1) await s.downloadWanted();
    const e4 = episodesOf(p.id).find((e) => e.guid === 'e4')!;
    expect(e4).toMatchObject({ status: 'failed', attempts: 3 });
    expect(calls.filter((c) => c.url.endsWith('e4.mp3'))).toHaveLength(3);
    expect(await readdir(join(root, 'The Show', '2025'))).toEqual([]);
  });

  it('gives two episodes with the same date and title distinct files', async () => {
    routes[FEED] = ok(
      feedXml('The Show', [
        { guid: 'a', title: 'Same', date: '2025-01-20T10:00:00Z' },
        { guid: 'b', title: 'Same', date: '2025-01-20T12:00:00Z' },
      ]),
    );
    routes['https://cdn.example.com/a.mp3'] = ok('a', { 'content-type': 'audio/mpeg' });
    routes['https://cdn.example.com/b.mp3'] = ok('b', { 'content-type': 'audio/mpeg' });
    const s = service();
    const p = await s.add({ feedUrl: FEED });
    await s.downloadWanted();
    const paths = episodesOf(p.id).map((e) => e.path);
    expect(new Set(paths).size).toBe(2);
    expect(paths.every((x) => x !== null)).toBe(true);
  });

  it('deletes a file and its sidecars', async () => {
    const s = service();
    const p = await s.add({ feedUrl: FEED, settings: { backlog: 1 } });
    await s.downloadWanted();
    const ep = episodesOf(p.id).find((e) => e.status === 'downloaded')!;
    await writeFile(ep.path!.replace(/\.mp3$/, '.chapters.json'), '{}');
    await s.deleteFile(ep.id);
    expect(await readdir(join(root, 'The Show', '2025'))).toEqual([]);
    expect(episodesOf(p.id).find((e) => e.id === ep.id)!.status).toBe('deleted');
  });
});

describe('retention and played state', () => {
  it('keeps only the newest N', async () => {
    const s = service();
    const p = await s.add({ feedUrl: FEED, settings: { backlog: 4, keepLast: 2 } });
    await s.downloadWanted();
    const eps = episodesOf(p.id);
    expect(eps.filter((e) => e.status === 'downloaded').map((e) => e.guid).sort()).toEqual(['e3', 'e4']);
    // Retention runs before the downloads, so the older backlog is never fetched.
    expect(calls.some((c) => c.url.endsWith('e1.mp3'))).toBe(false);
  });

  it('deletes played episodes after X days, using media-server listen history', async () => {
    const played = new Map<string, string | null>();
    const s = service({ playedPaths: async () => played });
    const p = await s.add({ feedUrl: FEED, settings: { backlog: 2, deletePlayedAfterDays: 3 } });
    await s.downloadWanted();
    const e4 = episodesOf(p.id).find((e) => e.guid === 'e4')!;
    played.set(e4.path!, '2025-01-23T00:00:00.000Z');
    expect(await s.syncPlayed()).toBe('1 episode marked played');
    expect(episodesOf(p.id).find((e) => e.id === e4.id)).toMatchObject({ played: true, playedSource: 'mediaServer' });

    await s.applyRetention();
    expect(episodesOf(p.id).find((e) => e.id === e4.id)!.status).toBe('downloaded');
    now = new Date('2025-01-27T00:00:00Z');
    await s.applyRetention();
    expect(episodesOf(p.id).find((e) => e.id === e4.id)).toMatchObject({ status: 'deleted', path: null });
    await expect(stat(e4.path!)).rejects.toThrow();
    expect(episodesOf(p.id).find((e) => e.guid === 'e3')!.status).toBe('downloaded');
  });

  it('marks played by hand', async () => {
    const s = service();
    const p = await s.add({ feedUrl: FEED });
    const id = episodesOf(p.id)[0]!.id;
    expect(s.setPlayed(id, true).played).toBe(true);
    expect(s.setPlayed(id, false).played).toBe(false);
    expect(s.episodes({ podcastId: p.id, played: false }).totalRecords).toBe(4);
  });
});

describe('OPML', () => {
  it('imports feeds, reports existing and failed ones, and exports without private feeds by default', async () => {
    const s = service();
    await s.add({ feedUrl: FEED });
    const other = 'https://feeds.example.com/other.xml';
    const secret = 'https://feeds.example.com/private.xml?token=abc123';
    routes[other] = ok(feedXml('Other Show', [{ guid: 'o1', title: 'O', date: '2025-01-10T00:00:00Z' }]));
    routes[secret] = ok(feedXml('Members Only', [{ guid: 's1', title: 'S', date: '2025-01-10T00:00:00Z' }]));
    const opml = `<?xml version="1.0"?><opml version="2.0"><head><title>x</title></head><body>
<outline text="The Show" type="rss" xmlUrl="${FEED}"/>
<outline text="Other" type="rss" xmlUrl="${other}"/>
<outline text="Members" type="rss" xmlUrl="${secret.replace('&', '&amp;')}"/>
<outline text="Dead" type="rss" xmlUrl="https://feeds.example.com/dead.xml"/></body></opml>`;
    const res = await s.importOpml({ opml });
    expect(res.added.map((a) => a.title).sort()).toEqual(['Members Only', 'Other Show']);
    expect(res.existing.map((a) => a.title)).toEqual(['The Show']);
    expect(res.failed).toHaveLength(1);

    const pub = s.exportOpml(false);
    expect(pub).toContain(FEED);
    expect(pub).toContain(other);
    expect(pub).not.toContain('abc123');
    expect(s.exportOpml(true)).toContain('abc123');
  });
});

describe('calendar', () => {
  it('lists episodes published in the window of monitored podcasts', async () => {
    const s = service();
    const p = await s.add({ feedUrl: FEED });
    const items = s.calendar(new Date('2025-01-07T00:00:00Z'), new Date('2025-01-16T00:00:00Z'));
    expect(items.map((i) => i.episode.title)).toEqual(['Two', 'Three']);
    expect(items[0]).toMatchObject({ type: 'podcastEpisode', podcastId: p.id, podcastTitle: 'The Show' });
    s.update(p.id, { monitored: false });
    expect(s.calendar(new Date('2025-01-01T00:00:00Z'), new Date('2025-02-01T00:00:00Z'))).toHaveLength(0);
    expect(s.calendar(new Date('2025-01-01T00:00:00Z'), new Date('2025-02-01T00:00:00Z'), { unmonitored: true })).toHaveLength(4);
  });
});

describe('suggestions', () => {
  function addUser(name: string, permissions: number, settings: Record<string, unknown> = {}): number {
    const at = new Date().toISOString();
    return db
      .insert(users)
      .values({ username: name, usernameKey: name, passwordHash: 'disabled$test', role: 'user', permissions, settings, createdAt: at, updatedAt: at })
      .returning({ id: users.id })
      .get().id;
  }

  it('lets a requester suggest, hides the feed secret from them and lets a manager approve', async () => {
    const s = service();
    const sug = new PodcastSuggestions({ db, podcasts: s, now: () => now });
    const uid = addUser('listener', Permission.REQUEST_MUSIC);
    const user = { userId: uid, permissions: Permission.REQUEST_MUSIC };
    const secretUrl = `${FEED}?token=abc123`;
    routes[secretUrl] = routes[FEED]!;
    const created = await sug.create(user, { feedUrl: secretUrl });
    expect(created).toMatchObject({ status: 'pending', title: 'The Show', username: 'listener' });
    expect(created.feedUrl).not.toContain('abc123');
    await expect(sug.create(user, { feedUrl: secretUrl })).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(sug.list({ userId: addUser('someone', Permission.REQUEST), permissions: Permission.REQUEST })).toHaveLength(0);
    await expect(sug.approve(user, created.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const manager = { userId: null, permissions: Permission.ADMIN };
    const approved = await sug.approve(manager, created.id);
    expect(approved.status).toBe('approved');
    expect(approved.podcastId).toBe(s.list()[0]!.id);
    // Already subscribed now.
    await expect(sug.create(user, { feedUrl: secretUrl })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('never fetches a LAN address for a suggestion and answers with one generic error (DATA-06)', async () => {
    const policies: Array<{ trustedHost?: string }> = [];
    let direct = 0;
    // The real transport, with a counting wrapper: a loopback suggestion must not get a socket.
    const s = service({
      transport: (_tags, policy = {}) => {
        policies.push(policy);
        const real = transportFor(undefined, undefined, policy);
        return async (url, init) => {
          direct += 1;
          return real(url, init);
        };
      },
    });
    const sug = new PodcastSuggestions({ db, podcasts: s });
    const uid = addUser('prober', Permission.REQUEST);
    for (const feedUrl of ['http://127.0.0.1:1/', 'http://nas.lan/feed.xml', 'http://[::ffff:127.0.0.1]:1/']) {
      const err = await sug.create({ userId: uid, permissions: Permission.REQUEST }, { feedUrl }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'FEED', message: 'that address could not be read as a podcast feed' });
    }
    expect(policies.every((p) => p.trustedHost === undefined)).toBe(true);
    expect(direct).toBe(3);
  });

  it('trusts a LAN feed host only for admins and only for that host', async () => {
    const policies: Array<{ trustedHost?: string }> = [];
    const lan = 'http://nas.lan:8080/feed.xml';
    routes[lan] = routes[FEED]!;
    const s = service({
      transport: (_tags, policy = {}) => {
        policies.push(policy);
        return transport;
      },
    });
    await s.preview(lan);
    expect(policies.pop()).toEqual({});
    await s.preview(lan, { trusted: true });
    expect(policies.pop()).toEqual({ trustedHost: 'nas.lan' });
    await s.preview(FEED, { trusted: true });
    expect(policies.pop()).toEqual({});
  });

  it('respects the per-user request-type filter and the permission bits', async () => {
    const s = service();
    const sug = new PodcastSuggestions({ db, podcasts: s });
    const off = addUser('nopods', Permission.REQUEST, { requestTypes: { podcast: false } });
    await expect(sug.create({ userId: off, permissions: Permission.REQUEST }, { feedUrl: FEED })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const none = addUser('none', 0);
    await expect(sug.create({ userId: none, permissions: 0 }, { feedUrl: FEED })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('auto-approves for users who may, and lets owners withdraw pending ones', async () => {
    const s = service();
    const sug = new PodcastSuggestions({ db, podcasts: s });
    const auto = addUser('auto', Permission.REQUEST | Permission.AUTO_APPROVE);
    expect((await sug.create({ userId: auto, permissions: Permission.REQUEST | Permission.AUTO_APPROVE }, { feedUrl: FEED })).status).toBe('approved');

    const other = 'https://feeds.example.com/other.xml';
    routes[other] = ok(feedXml('Other Show', [{ guid: 'o1', title: 'O', date: '2025-01-10T00:00:00Z' }]));
    const uid = addUser('plain', Permission.REQUEST);
    const mine = await sug.create({ userId: uid, permissions: Permission.REQUEST }, { feedUrl: other });
    expect(() => sug.remove({ userId: auto, permissions: Permission.REQUEST }, mine.id)).toThrow(PodcastsError);
    sug.remove({ userId: uid, permissions: Permission.REQUEST }, mine.id);
    expect(sug.list({ userId: null, permissions: Permission.ADMIN }).map((x) => x.title)).toEqual(['The Show']);
  });
});
