import { describe, expect, it } from 'vitest';
import { CookieJar } from './cookies.js';
import { createDefinitionIndexer } from './indexer.js';
import { MAX_TORRENT_BYTES } from './runtime.js';

// DATA-20 / DATA-40: the definition runtime keeps the tracker session on the tracker.

const DEF = `
id: scoped
name: Scoped
type: private
links: [https://tracker.example/]
settings: []
caps:
  categorymappings: [{id: 1, cat: Movies}]
  modes: {search: [q]}
search:
  path: browse
  rows: {selector: tr}
  fields: {title: {selector: td}}
download:
  selectors:
    - selector: "a.dl"
      attribute: href
`;
const TORRENT = 'd8:announce17:http://t.example/4:infod4:name3:abcee';

interface Seen {
  url: string;
  cookie: string | null;
  auth: string | null;
}

function recorder(route: (url: URL) => Response) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    seen.push({ url, cookie: h.get('cookie'), auth: h.get('authorization') });
    return route(new URL(url));
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const publicResolver = { resolve: async () => [{ address: '93.184.216.34', family: 4 }] };
const lanResolver = { resolve: async () => [{ address: '192.168.1.20', family: 4 }] };
const torrent = () => new Response(TORRENT, { headers: { 'content-type': 'application/x-bittorrent' } });

describe('definition runtime: foreign hosts', () => {
  it('sends no Cookie to another host a tracker redirects to', async () => {
    const r = recorder((url) => {
      if (url.host === 'tracker.example') return new Response(null, { status: 302, headers: { location: 'https://collector.example/grab.torrent', 'set-cookie': 'x=1' } });
      return torrent();
    });
    const indexer = createDefinitionIndexer(DEF.replace(/download:[\s\S]*$/, ''), {}, {
      fetchImpl: r.fetchImpl,
      jar: new CookieJar({ session: 'secret' }),
      foreignTargetPolicy: publicResolver,
    });
    const result = await indexer.download('https://tracker.example/dl/1');
    expect(result.kind).toBe('torrent');
    expect(r.seen[0]).toMatchObject({ url: 'https://tracker.example/dl/1', cookie: expect.stringContaining('session=secret') });
    expect(r.seen[1]).toMatchObject({ url: 'https://collector.example/grab.torrent', cookie: null, auth: null });
  });

  it('keeps cookies on subdomains of the site and drops them for a scraped link elsewhere', async () => {
    const r = recorder((url) => {
      if (url.pathname === '/details/1') return new Response('<a class="dl" href="https://cdn.other.example/a.torrent">x</a>', { headers: { 'content-type': 'text/html' } });
      return torrent();
    });
    const indexer = createDefinitionIndexer(DEF, {}, { fetchImpl: r.fetchImpl, jar: new CookieJar({ session: 'secret' }), foreignTargetPolicy: publicResolver });
    await indexer.download('https://tracker.example/details/1');
    expect(r.seen.find((s) => s.url.includes('other.example'))?.cookie).toBeNull();

    const sub = recorder(() => torrent());
    const onSub = createDefinitionIndexer(DEF.replace(/download:[\s\S]*$/, ''), {}, { fetchImpl: sub.fetchImpl, jar: new CookieJar({ session: 'secret' }) });
    await onSub.download('https://dl.tracker.example/a.torrent');
    expect(sub.seen[0]?.cookie).toContain('session=secret');
  });

  it('refuses a foreign host on a private address but allows a LAN site link', async () => {
    const r = recorder((url) => {
      if (url.host === 'tracker.example') return new Response(null, { status: 302, headers: { location: 'https://intranet.example/admin' } });
      return torrent();
    });
    const indexer = createDefinitionIndexer(DEF.replace(/download:[\s\S]*$/, ''), {}, { fetchImpl: r.fetchImpl, foreignTargetPolicy: lanResolver });
    await expect(indexer.download('https://tracker.example/dl/1')).rejects.toThrow(/local or reserved/);
    expect(r.seen.map((s) => s.url)).toEqual(['https://tracker.example/dl/1']);

    // The admin's own LAN tracker (the definition's site link) is fine.
    const lan = recorder(() => torrent());
    const local = createDefinitionIndexer(DEF.replace('https://tracker.example/', 'http://192.168.1.20:8080/').replace(/download:[\s\S]*$/, ''), {}, { fetchImpl: lan.fetchImpl, foreignTargetPolicy: lanResolver });
    expect((await local.download('http://192.168.1.20:8080/dl/1')).kind).toBe('torrent');
  });

  it('caps the torrent body', async () => {
    const r = recorder(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(ctrl) {
              ctrl.enqueue(new Uint8Array(1024 * 1024));
            },
          }),
          { headers: { 'content-type': 'application/x-bittorrent' } },
        ),
    );
    const indexer = createDefinitionIndexer(DEF.replace(/download:[\s\S]*$/, ''), {}, { fetchImpl: r.fetchImpl });
    await expect(indexer.download('https://tracker.example/dl/1')).rejects.toThrow(/too large/);
    expect(MAX_TORRENT_BYTES).toBe(10 * 1024 * 1024);
  });

  it('logs only the host of a rejected download candidate (DATA-40)', async () => {
    const lines: string[] = [];
    const r = recorder((url) => {
      if (url.pathname === '/details/1') return new Response('<a class="dl" href="/dl.php?id=1&passkey=0123456789abcdef">x</a>', { headers: { 'content-type': 'text/html' } });
      return new Response('<html>nope</html>', { headers: { 'content-type': 'text/html' } });
    });
    const indexer = createDefinitionIndexer(DEF.replace('testlinktorrent', 'x'), {}, { fetchImpl: r.fetchImpl, log: (_l, m) => lines.push(m) });
    await expect(indexer.download('https://tracker.example/details/1')).rejects.toThrow();
    expect(lines.some((l) => l.includes('tracker.example'))).toBe(true);
    expect(lines.join('\n')).not.toContain('passkey');
  });
});
