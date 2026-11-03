import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedUrlHasCredentials, redactFeedUrl, redactUrlsInText } from '@arclight/shared';
import { applePodcastsId, podcastIndexHeaders, searchDirectory, searchItunes } from './directory.js';
import { downloadFile, fetchFeed, follow, isMediaContentType, lanFeedHost, PodcastHttpError, splitCredentials, transportFor, type Transport } from './http.js';
import { enclosureExtension, episodePath, podcastFolder, renderFormat, safeSegment } from './naming.js';
import { buildOpml, OpmlError, parseOpml } from './opml.js';
import { carryCredentials, parseChapters, sameFeedUrl, transcriptExtension } from './service.js';
import { FfmpegTagger, ffmetadataChapters, tagArgs, type TagRequest } from './tagger.js';

/** A scripted transport: url → response factory; records every request. */
export function fakeTransport(routes: Record<string, (headers: Record<string, string>) => Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const transport: Transport = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return route(init.headers);
  };
  return { transport, calls };
}

const redirect = (status: number, location: string) => () => new Response(null, { status, headers: { location } });
const xml = (body: string, headers: Record<string, string> = {}) => () =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml', ...headers } });

describe('feed URL redaction', () => {
  it('detects credentials', () => {
    expect(feedUrlHasCredentials('https://user:pass@feeds.example.com/x.xml')).toBe(true);
    expect(feedUrlHasCredentials('https://feeds.example.com/x.xml?auth=abc')).toBe(true);
    expect(feedUrlHasCredentials('https://feeds.example.com/p/a1b2c3d4e5f6g7h8i9j0k1l2/feed.xml')).toBe(true);
    expect(feedUrlHasCredentials('https://feeds.example.com/show/feed.xml?format=mp3')).toBe(false);
  });

  it('masks user info, secret query values and token path segments', () => {
    expect(redactFeedUrl('https://user:pass@feeds.example.com/x.xml')).toBe('https://********:********@feeds.example.com/x.xml');
    expect(redactFeedUrl('https://feeds.example.com/x.xml?token=s3cret&format=mp3')).toBe('https://feeds.example.com/x.xml?token=********&format=mp3');
    expect(redactFeedUrl('https://feeds.example.com/p/a1b2c3d4e5f6g7h8i9j0k1l2.rss')).toBe('https://feeds.example.com/p/********.rss');
    expect(redactFeedUrl('not a url')).toBe('not a url');
  });

  it('masks URLs inside error text', () => {
    expect(redactUrlsInText('GET https://u:p@feeds.example.com/x.xml failed')).toBe('GET https://********:********@feeds.example.com/x.xml failed');
  });

  it('compares and moves feed URLs', () => {
    expect(sameFeedUrl('http://Feeds.example.com/a/', 'https://feeds.example.com/a')).toBe(true);
    expect(sameFeedUrl('https://feeds.example.com/a', 'https://feeds.example.com/b')).toBe(false);
    expect(carryCredentials('https://u:p@feeds.example.com/old', 'https://feeds.example.com/new')).toBe('https://u:p@feeds.example.com/new');
    // Never hand credentials to another host.
    expect(carryCredentials('https://u:p@feeds.example.com/old', 'https://other.example.com/new')).toBe('https://other.example.com/new');
  });
});

describe('http: redirects, credentials, conditional GET', () => {
  it('turns user info into Basic auth and sends it only to the original origin', async () => {
    expect(splitCredentials('https://al%40x:p%3Aw@feeds.example.com/f').auth).toBe(`Basic ${Buffer.from('al@x:p:w').toString('base64')}`);
    const { transport, calls } = fakeTransport({
      'https://feeds.example.com/f': redirect(302, '/g'),
      'https://feeds.example.com/g': redirect(302, 'https://cdn.example.com/h'),
      'https://cdn.example.com/h': xml('<rss/>'),
    });
    const res = await follow(transport, 'https://u:p@feeds.example.com/f');
    expect(res.url).toBe('https://cdn.example.com/h');
    expect(res.permanent).toBe(false);
    expect(calls.map((c) => Boolean(c.headers.authorization))).toEqual([true, true, false]);
    expect(calls.every((c) => !c.url.includes('@'))).toBe(true);
  });

  it('reports a chain of 301/308 as permanent', async () => {
    const { transport } = fakeTransport({
      'https://feeds.example.com/a': redirect(301, 'https://feeds.example.com/b'),
      'https://feeds.example.com/b': redirect(308, 'https://feeds.example.com/c'),
      'https://feeds.example.com/c': xml('<rss/>', { etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2025 00:00:00 GMT' }),
    });
    const res = await fetchFeed(transport, 'https://feeds.example.com/a');
    expect(res).toMatchObject({ status: 'ok', url: 'https://feeds.example.com/c', permanent: true, etag: '"v1"', body: '<rss/>' });
  });

  it('sends If-None-Match / If-Modified-Since and understands 304', async () => {
    const { transport, calls } = fakeTransport({ 'https://feeds.example.com/a': () => new Response(null, { status: 304 }) });
    const res = await fetchFeed(transport, 'https://feeds.example.com/a', { etag: '"v1"', lastModified: 'Mon, 01 Jan 2025 00:00:00 GMT' });
    expect(res.status).toBe('notModified');
    expect(calls[0]!.headers['if-none-match']).toBe('"v1"');
    expect(calls[0]!.headers['if-modified-since']).toBe('Mon, 01 Jan 2025 00:00:00 GMT');
  });

  it('flags 410 as gone and redacts URLs in errors', async () => {
    const { transport } = fakeTransport({ 'https://feeds.example.com/x.xml?token=abc': () => new Response('bye', { status: 410 }) });
    const err = await fetchFeed(transport, 'https://feeds.example.com/x.xml?token=abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PodcastHttpError);
    expect((err as PodcastHttpError).gone).toBe(true);
    expect((err as Error).message).not.toContain('abc');
  });

  it('stops redirect loops', async () => {
    const { transport } = fakeTransport({
      'https://feeds.example.com/a': redirect(302, 'https://feeds.example.com/b'),
      'https://feeds.example.com/b': redirect(302, 'https://feeds.example.com/a'),
    });
    await expect(fetchFeed(transport, 'https://feeds.example.com/a')).rejects.toThrow(/too many redirects/);
  });

  it('decodes the charset from the XML declaration', async () => {
    const latin1 = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Caf'), Buffer.from([0xe9]), Buffer.from('</title></channel></rss>')]);
    const { transport } = fakeTransport({ 'https://feeds.example.com/l': () => new Response(latin1, { status: 200, headers: { 'content-type': 'text/xml' } }) });
    const res = await fetchFeed(transport, 'https://feeds.example.com/l');
    expect(res.status === 'ok' && res.body).toContain('Café');
  });
});

describe('http: downloads', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arclight-podcast-dl-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams a file to disk', async () => {
    const { transport } = fakeTransport({ 'https://cdn.example.com/a.mp3': () => new Response(Buffer.alloc(4096, 1), { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '4096' } }) });
    const res = await downloadFile(transport, 'https://cdn.example.com/a.mp3', join(dir, 'a.mp3'));
    expect(res.bytes).toBe(4096);
    expect((await readFile(join(dir, 'a.mp3'))).length).toBe(4096);
  });

  it('refuses a web page and empty bodies', async () => {
    const { transport } = fakeTransport({
      'https://cdn.example.com/page': () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      'https://cdn.example.com/empty': () => new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    });
    await expect(downloadFile(transport, 'https://cdn.example.com/page', join(dir, 'p'))).rejects.toThrow(/web page/);
    await expect(downloadFile(transport, 'https://cdn.example.com/empty', join(dir, 'e'))).rejects.toThrow(/empty/);
  });
});

describe('http: indexer proxy (HTTP CONNECT) is used for feeds', () => {
  let origin: Server;
  let proxy: Server;
  let tunnels = 0;
  beforeAll(async () => {
    origin = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"p1"' });
      res.end('<rss version="2.0"><channel><title>Via proxy</title></channel></rss>');
    });
    proxy = createServer();
    proxy.on('connect', (req, client, head) => {
      tunnels += 1;
      const [host, port] = (req.url ?? '').split(':');
      const upstream = connect(Number(port), host!, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    await new Promise((r) => origin.close(r));
    await new Promise((r) => proxy.close(r));
  });

  it('tunnels the request through the proxy', async () => {
    const transport = transportFor({ type: 'http', host: '127.0.0.1', port: (proxy.address() as AddressInfo).port }, undefined, { trustedHost: '127.0.0.1' });
    const res = await fetchFeed(transport, `http://127.0.0.1:${(origin.address() as AddressInfo).port}/feed.xml`);
    expect(res.status === 'ok' && res.body).toContain('Via proxy');
    expect(res.status === 'ok' && res.etag).toBe('"p1"');
    expect(tunnels).toBe(1);
  });
});

describe('directories', () => {
  it('signs Podcast Index requests', () => {
    const h = podcastIndexHeaders('KEY', 'SECRET', 1_700_000_000);
    expect(h['x-auth-key']).toBe('KEY');
    expect(h['x-auth-date']).toBe('1700000000');
    // sha1("KEYSECRET1700000000")
    expect(h.authorization).toMatch(/^[0-9a-f]{40}$/);
    expect(podcastIndexHeaders('KEY', 'SECRET', 1_700_000_000).authorization).toBe(h.authorization);
    expect(podcastIndexHeaders('KEY', 'SECRET', 1_700_000_001).authorization).not.toBe(h.authorization);
  });

  it('reads Apple Podcasts ids', () => {
    expect(applePodcastsId('https://podcasts.apple.com/us/podcast/some-show/id1234567890')).toBe(1234567890);
    expect(applePodcastsId('https://itunes.apple.com/podcast/id98765?mt=2')).toBe(98765);
    expect(applePodcastsId('https://feeds.example.com/id12345')).toBeNull();
  });

  it('maps iTunes search results', async () => {
    const body = JSON.stringify({
      results: [
        { collectionId: 42, collectionName: 'Found Show', artistName: 'Finder', feedUrl: 'https://feeds.example.com/found.xml', artworkUrl600: 'https://example.com/a.jpg', trackCount: 12, genres: ['Podcasts', 'Science'], collectionExplicitness: 'notExplicit' },
        { collectionId: 43, collectionName: 'No feed' },
      ],
    });
    const transport: Transport = async (url) => {
      expect(url).toContain('media=podcast');
      expect(url).toContain('term=found');
      expect(url).toContain('country=de');
      return new Response(body, { status: 200 });
    };
    const opts = { transport, country: 'DE', podcastIndexKey: null, podcastIndexSecret: null };
    const hits = await searchItunes(opts, 'found');
    expect(hits).toEqual([
      { source: 'itunes', title: 'Found Show', author: 'Finder', feedUrl: 'https://feeds.example.com/found.xml', imageUrl: 'https://example.com/a.jpg', description: null, categories: ['Science'], episodeCount: 12, itunesId: 42, podcastIndexId: null, explicit: false },
    ]);
    await expect(searchDirectory(opts, 'found', 'podcastindex')).rejects.toThrow(/API key/);
  });

  it('uses Podcast Index by default once it has a key', async () => {
    const seen: string[] = [];
    const transport: Transport = async (url, init) => {
      seen.push(url);
      expect(init.headers['x-auth-key']).toBe('k');
      return new Response(JSON.stringify({ status: 'true', feeds: [{ id: 7, title: 'PI Show', url: 'https://feeds.example.com/pi.xml', author: 'PI', artwork: 'https://example.com/pi.jpg', itunesId: 99, categories: { 1: 'Tech' }, episodeCount: 3, explicit: false }] }), { status: 200 });
    };
    const hits = await searchDirectory({ transport, country: 'us', podcastIndexKey: 'k', podcastIndexSecret: 's', now: () => 1_700_000_000_000 }, 'pi');
    expect(seen[0]).toContain('api.podcastindex.org/api/1.0/search/byterm?q=pi');
    expect(hits[0]).toMatchObject({ source: 'podcastindex', title: 'PI Show', podcastIndexId: 7, itunesId: 99, categories: ['Tech'] });
  });
});

describe('OPML', () => {
  it('reads nested outlines and skips duplicates and non-http entries', () => {
    const doc = `<?xml version="1.0"?><opml version="2.0"><head/><body>
      <outline text="News"><outline type="rss" text="A &amp; B" xmlUrl="https://feeds.example.com/a.xml"/>
        <outline type="rss" text="Dup" xmlUrl="https://feeds.example.com/a.xml"/></outline>
      <outline type="rss" title="C" xmlUrl="https://feeds.example.com/c.xml"/>
      <outline type="rss" text="Local" xmlUrl="file:///etc/passwd"/>
      <outline type="link" text="Single" url="http://feeds.example.com/d.xml"/>
    </body></opml>`;
    expect(parseOpml(doc)).toEqual([
      { feedUrl: 'https://feeds.example.com/a.xml', title: 'A & B' },
      { feedUrl: 'https://feeds.example.com/c.xml', title: 'C' },
      { feedUrl: 'http://feeds.example.com/d.xml', title: 'Single' },
    ]);
  });

  it('rejects documents that are not OPML', () => {
    expect(() => parseOpml('<rss/>')).toThrow(OpmlError);
  });

  it('round-trips an export', () => {
    const out = buildOpml([{ title: 'Q & "A"', feedUrl: 'https://feeds.example.com/q.xml?x=1&y=2', link: 'https://example.com/q' }], new Date('2025-01-01T00:00:00Z'));
    expect(out).toContain('xmlUrl="https://feeds.example.com/q.xml?x=1&amp;y=2"');
    expect(parseOpml(out)).toEqual([{ feedUrl: 'https://feeds.example.com/q.xml?x=1&y=2', title: 'Q & "A"' }]);
  });
});

describe('naming', () => {
  const input = { podcastTitle: 'Show: The <Best>', podcastAuthor: 'Ann', episodeTitle: 'Part 1/2? "Live"', publishedAt: '2025-03-04T05:06:07Z', season: 2, episodeNumber: 7 };

  it('makes safe path segments', () => {
    expect(safeSegment('a:b/c\\d*?<>|"e". ')).toBe("a -b-c-d'e'");
    expect(safeSegment('CON')).toBe('CON_');
    expect(safeSegment('   ')).toBe('_');
  });

  it('renders the default formats', () => {
    expect(renderFormat('{Episode Year}/{Episode Date} - {Episode Title}', input)).toEqual(['2025', "2025-03-04 - Part 1-2 'Live'"]);
    expect(podcastFolder(join('/', 'pods'), '{Podcast Title}', input)).toBe(join('/', 'pods', 'Show - The Best'));
    expect(episodePath(join('/', 'pods', 'S'), 'S{Season}E{Episode Number} - {Episode Title}', input, '.mp3')).toBe(join('/', 'pods', 'S', "S02E007 - Part 1-2 'Live'.mp3"));
  });

  it('handles undated episodes and dangling separators', () => {
    expect(renderFormat('{Episode Year}/{Episode Date} - {Episode Title}', { podcastTitle: 'x', podcastAuthor: null, episodeTitle: 'T', publishedAt: null })).toEqual(['Undated', 'Undated - T']);
    expect(renderFormat('{Season} - {Episode Title}', { podcastTitle: 'x', podcastAuthor: null, episodeTitle: 'T' })).toEqual(['T']);
  });

  it('picks file extensions', () => {
    expect(enclosureExtension('https://cdn.example.com/a.m4a?x=1', 'audio/mpeg')).toBe('.m4a');
    expect(enclosureExtension('https://cdn.example.com/stream', 'audio/mpeg; charset=x')).toBe('.mp3');
    expect(enclosureExtension('https://cdn.example.com/stream', null)).toBe('.mp3');
    expect(enclosureExtension('https://cdn.example.com/v', 'video/mp4')).toBe('.mp4');
  });
});

describe('chapters and transcripts', () => {
  it('reads Podcasting 2.0 chapters JSON', () => {
    const json = JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 0, title: 'Intro' }, { startTime: 61.5, title: 'Hidden', toc: false }, { startTime: 120, endTime: 300, title: 'Main' }, { title: 'No time' }] });
    expect(parseChapters(json)).toEqual([
      { startSeconds: 0, endSeconds: null, title: 'Intro' },
      { startSeconds: 120, endSeconds: 300, title: 'Main' },
    ]);
    expect(parseChapters('nope')).toBeNull();
    expect(parseChapters('{"x":1}')).toBeNull();
  });

  it('maps transcript types to extensions', () => {
    expect(transcriptExtension('text/vtt')).toBe('vtt');
    expect(transcriptExtension('application/x-subrip')).toBe('srt');
    expect(transcriptExtension('application/json; charset=utf-8')).toBe('json');
    expect(transcriptExtension('application/pdf')).toBeNull();
  });
});

describe('tagger', () => {
  const req: TagRequest = {
    file: join('/', 'p', 'ep.mp3'),
    tags: { title: 'Ep', podcast: 'Show', author: null, date: '2025-03-04T00:00:00Z', description: 'About', episodeNumber: 3, season: null, link: 'https://example.com/e' },
    coverFile: join('/', 'p', 'cover.jpg'),
    chapters: [],
    durationSeconds: 600,
  };

  it('writes FFMETADATA chapters with end times', () => {
    const meta = ffmetadataChapters([{ startSeconds: 30, endSeconds: null, title: 'B=2;' }, { startSeconds: 0, endSeconds: null, title: 'A' }], 100);
    expect(meta).toBe(';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=30000\ntitle=A\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=30000\nEND=100000\ntitle=B\\=2\\;\n');
  });

  it('builds stream-copy arguments with cover art for MP3', () => {
    const args = tagArgs(req, 'out.mp3', 'ch.txt');
    expect(args).toEqual(expect.arrayContaining(['-c', 'copy', '-id3v2_version', '3', '-map_chapters', '2', 'attached_pic']));
    expect(args).toContain('album=Show');
    expect(args).toContain('artist=Show');
    expect(args).toContain('date=2025-03-04');
    expect(args).toContain('track=3');
    expect(args.join(' ')).not.toContain('disc=');
    expect(args.at(-1)).toBe('out.mp3');
  });

  it('skips cover art for containers that cannot hold it, and adds faststart for MP4', () => {
    const args = tagArgs({ ...req, file: 'ep.mp4' }, 'out.mp4', null);
    expect(args).not.toContain('attached_pic');
    expect(args).toEqual(expect.arrayContaining(['-map', '0', '-movflags', '+faststart']));
  });

  it('does nothing without ffmpeg or for unknown containers', async () => {
    let ran = false;
    const exec = async () => {
      ran = true;
    };
    expect(await new FfmpegTagger({ ffmpegPath: null, exec }).tag(req)).toBe(false);
    expect(await new FfmpegTagger({ ffmpegPath: 'ffmpeg', exec }).tag({ ...req, file: 'ep.wav' })).toBe(false);
    expect(ran).toBe(false);
  });
});

describe('http: local network guard (DATA-06)', () => {
  let inner: Server;
  let outer: Server;
  let innerHits = 0;
  beforeAll(async () => {
    inner = createServer((_q, s) => {
      innerHits += 1;
      s.writeHead(200, { 'content-type': 'audio/mpeg' });
      s.end('secret');
    });
    outer = createServer((_q, s) => {
      s.writeHead(302, { location: `http://127.0.0.1:${(inner.address() as AddressInfo).port}/latest/meta-data/` });
      s.end();
    });
    await new Promise<void>((r) => inner.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => outer.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    await new Promise((r) => inner.close(r));
    await new Promise((r) => outer.close(r));
  });

  it('refuses loopback feeds and enclosures on the direct path', async () => {
    const port = (inner.address() as AddressInfo).port;
    await expect(fetchFeed(transportFor(undefined), `http://127.0.0.1:${port}/feed.xml`)).rejects.toThrow(/local network/);
    await expect(fetchFeed(transportFor(undefined), `http://[::ffff:127.0.0.1]:${port}/feed.xml`)).rejects.toThrow(/local network/);
    expect(innerHits).toBe(0);
  });

  it('allows the trusted LAN feed host itself but not a redirect elsewhere', async () => {
    const port = (inner.address() as AddressInfo).port;
    const trusted = transportFor(undefined, undefined, { trustedHost: 'localhost' });
    const ok = await follow(trusted, `http://localhost:${port}/ep.mp3`);
    expect(ok.response.status).toBe(200);
    await ok.response.body?.cancel();
    expect(innerHits).toBe(1);
    // outer (trusted name) redirects to 127.0.0.1, a different private host: refused.
    await expect(follow(trusted, `http://localhost:${(outer.address() as AddressInfo).port}/r`)).rejects.toThrow(/local network/);
    expect(innerHits).toBe(1);
  });

  it('refuses private host names through a proxy without opening a tunnel', async () => {
    const t = transportFor({ type: 'http', host: '127.0.0.1', port: 1 });
    await expect(follow(t, 'http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/local network/);
    await expect(follow(t, 'http://nas.lan/feed.xml')).rejects.toThrow(/local network/);
  });

  it('trusts only LAN-named feed hosts and only media bodies for episodes', () => {
    expect(lanFeedHost('http://nas.lan/feed')).toBe('nas.lan');
    expect(lanFeedHost('http://10.0.0.5/feed')).toBe('10.0.0.5');
    expect(lanFeedHost('https://feeds.example.com/feed')).toBeUndefined();
    expect(isMediaContentType('audio/mpeg')).toBe(true);
    expect(isMediaContentType('application/octet-stream')).toBe(true);
    expect(isMediaContentType('video/mp4; codecs=avc1')).toBe(true);
    expect(isMediaContentType('text/plain')).toBe(false);
    expect(isMediaContentType('application/json')).toBe(false);
    expect(isMediaContentType('application/rss+xml')).toBe(false);
  });
});
