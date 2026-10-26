// Site links: cross-host redirects within links/legacylinks, mirror fallback on network
// failures and 5xx, the `requiresFlareSolverr` marker and the definition `test` block,
// exercised against in-process HTTP servers.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexerError } from '../types.js';
import { loadDefinitionCatalogue, parseDefinitionYaml } from './catalogue.js';
import { createDefinitionIndexer } from './indexer.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface FakeSite {
  server: Server;
  base: string;
  host: string;
  hits: string[];
}

async function startSite(handler: Handler): Promise<FakeSite> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '/');
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}/`, host: `127.0.0.1:${port}`, hits };
}

const RESULTS = `<html><body><table>
<tr class="t"><td class="n">Mirror.Release.2024.1080p</td><td class="s">2 GB</td>
<td class="h">0123456789abcdef0123456789abcdef01234567</td></tr>
</table></body></html>`;

const serveResults: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(RESULTS);
};

const redirectTo =
  (target: () => string): Handler =>
  (req, res) => {
    res.writeHead(301, { location: `${target()}${(req.url ?? '/').slice(1)}` });
    res.end();
  };

let good: FakeSite;
let failing: FakeSite;
let mover: FakeSite;
let legacyMover: FakeSite;
let unknownMover: FakeSite;
let chain: FakeSite;
let blocked: FakeSite;
let elsewhere: FakeSite;

beforeAll(async () => {
  good = await startSite(serveResults);
  elsewhere = await startSite(serveResults);
  failing = await startSite((_req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<h1>Bad gateway</h1>');
  });
  mover = await startSite(redirectTo(() => good.base));
  legacyMover = await startSite(redirectTo(() => good.base));
  unknownMover = await startSite(redirectTo(() => elsewhere.base));
  chain = await startSite(redirectTo(() => mover.base));
  blocked = await startSite((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html>Forbidden</html>');
  });
});

afterAll(async () => {
  for (const s of [good, failing, mover, legacyMover, unknownMover, chain, blocked, elsewhere]) {
    await new Promise<void>((resolve) => s.server.close(() => resolve()));
  }
});

const DEAD = 'http://dead-mirror.example/';

/** Global fetch, except the DEAD host fails like a DNS lookup (`fetch failed` / ENOTFOUND). */
const dnsFailingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(DEAD)) {
    throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND dead-mirror.example') });
  }
  return fetch(input, init);
};

function definition(links: string[], extra = '', legacy: string[] = []): string {
  return `
id: mirrored
name: Mirrored
type: public
links: [${links.join(', ')}]
${legacy.length ? `legacylinks: [${legacy.join(', ')}]` : ''}
settings: []
caps:
  categorymappings: [{id: 1, cat: Movies/HD, desc: "Movies"}]
  modes: {search: [q]}
${extra}
search:
  paths:
    - path: browse.php
  inputs:
    q: "{{ .Keywords }}"
  rows: {selector: "tr.t"}
  fields:
    category: {text: 1}
    title: {selector: "td.n"}
    size: {selector: "td.s"}
    infohash: {selector: "td.h"}
`;
}

function indexer(yaml: string, logs: string[] = [], fetchImpl: typeof fetch = dnsFailingFetch) {
  return createDefinitionIndexer(parseDefinitionYaml(yaml), {}, {
    fetchImpl,
    sleep: async () => {},
    log: (level, message) => logs.push(`${level} ${message}`),
  });
}

async function rejection(promise: Promise<unknown>): Promise<IndexerError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof IndexerError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('link fallback', () => {
  it('moves to the next link on a DNS failure, logs it and stays there', async () => {
    const logs: string[] = [];
    const ix = indexer(definition([DEAD, good.base]), logs);
    const before = good.hits.length;
    const releases = await ix.search({ kind: 'search', query: 'mirror' });
    expect(releases.map((r) => r.title)).toEqual(['Mirror.Release.2024.1080p']);
    expect(ix.runtime.siteLink).toBe(good.base);
    expect(logs.some((l) => l.startsWith('warn') && l.includes(DEAD) && l.includes('ENOTFOUND'))).toBe(true);
    expect(logs).toContain(`info [mirrored] using link ${good.base} (${DEAD} failed)`);

    // The next search goes straight to the working link.
    let deadCalls = 0;
    const counting: typeof fetch = (input, init) => {
      if (String(input).startsWith(DEAD)) deadCalls++;
      return dnsFailingFetch(input, init);
    };
    const ix2 = indexer(definition([DEAD, good.base]), [], counting);
    await ix2.search({ kind: 'search', query: 'mirror' });
    await ix2.search({ kind: 'search', query: 'mirror' });
    expect(deadCalls).toBe(1);
    expect(good.hits.length - before).toBe(3);
  });

  it('moves to the next link on HTTP 5xx', async () => {
    const logs: string[] = [];
    const ix = indexer(definition([failing.base, good.base]), logs);
    const releases = await ix.search({ kind: 'search', query: 'mirror' });
    expect(releases).toHaveLength(1);
    expect(ix.runtime.siteLink).toBe(good.base);
    expect(logs.some((l) => l.includes('HTTP 502') && l.includes('trying next link'))).toBe(true);
  });

  it('reports every link when all of them fail', async () => {
    const ix = indexer(definition([DEAD, 'http://127.0.0.1:1/']));
    const err = await rejection(ix.search({ kind: 'search', query: 'x' }));
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain('All site links failed');
    expect(err.message).toContain(DEAD);
    expect(err.message).toContain('http://127.0.0.1:1/');
  });

  it('surfaces the 5xx of the last link when every link answers 5xx', async () => {
    const failing2 = await startSite((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/html' });
      res.end('<h1>Down</h1>');
    });
    try {
      const ix = indexer(definition([failing.base, failing2.base]));
      const err = await rejection(ix.search({ kind: 'search', query: 'x' }));
      expect(err.code).toBe('unreachable');
      expect(err.message).toBe('HTTP 503 from site');
    } finally {
      await new Promise<void>((resolve) => failing2.server.close(() => resolve()));
    }
  });

  it('does not fall back from a custom base URL outside links', async () => {
    const def = parseDefinitionYaml(definition([good.base]));
    const ix = createDefinitionIndexer(def, { sitelink: DEAD }, { fetchImpl: dnsFailingFetch, sleep: async () => {} });
    const err = await rejection(ix.search({ kind: 'search', query: 'x' }));
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain('ENOTFOUND');
    expect(ix.runtime.siteLink).toBe(DEAD);
  });

  it('falls back during test() as well', async () => {
    const result = await indexer(definition([DEAD, good.base])).test();
    expect(result.ok).toBe(true);
  });
});

describe('cross-host redirects', () => {
  it('follows a redirect to a host in links once and adopts it', async () => {
    const logs: string[] = [];
    const ix = indexer(definition([mover.base, good.base]), logs);
    const releases = await ix.search({ kind: 'search', query: 'mirror' });
    expect(releases).toHaveLength(1);
    expect(ix.runtime.siteLink).toBe(good.base);
    expect(logs).toContain(`info [mirrored] site redirected to ${good.base}; using it as the site link`);
    const moverHits = mover.hits.length;
    await ix.search({ kind: 'search', query: 'mirror' });
    expect(mover.hits.length).toBe(moverHits);
  });

  it('follows a redirect to a legacylinks host without adopting it', async () => {
    const ix = indexer(definition([legacyMover.base], '', [good.base]));
    const releases = await ix.search({ kind: 'search', query: 'mirror' });
    expect(releases).toHaveLength(1);
    expect(ix.runtime.siteLink).toBe(legacyMover.base);
  });

  it('names the new host when the redirect leaves the definition hosts', async () => {
    const ix = indexer(definition([unknownMover.base]));
    const err = await rejection(ix.search({ kind: 'search', query: 'x' }));
    expect(err.code).toBe('bad-response');
    expect(err.message).toContain(`Redirected to ${elsewhere.base}browse.php`);
    expect(err.message).toContain(`moved to ${elsewhere.host}`);
    expect(err.message).toContain("not in this definition's links");
  });

  it('follows only one cross-host hop per request', async () => {
    const ix = indexer(definition([chain.base, mover.base, good.base]));
    const err = await rejection(ix.search({ kind: 'search', query: 'x' }));
    expect(err.code).toBe('bad-response');
    expect(err.message).toContain(`Redirected to ${good.base}browse.php`);
    expect(err.message).toContain('only one redirect to another site link is followed per request');
    expect(ix.runtime.siteLink).toBe(mover.base);
  });

  it('keeps same-host redirects unfollowed as before', async () => {
    const same = await startSite((req, res) => {
      if (req.url?.startsWith('/browse.php')) {
        res.writeHead(302, { location: '/elsewhere.php' });
        res.end();
        return;
      }
      serveResults(req, res);
    });
    try {
      const err = await rejection(indexer(definition([same.base])).search({ kind: 'search', query: 'x' }));
      expect(err.message).toBe(`Redirected to ${same.base}elsewhere.php`);
    } finally {
      await new Promise<void>((resolve) => same.server.close(() => resolve()));
    }
  });
});

describe('requiresFlareSolverr', () => {
  const extra = 'requiresFlareSolverr: true';

  it('test() fails fast with a message naming FlareSolverr', async () => {
    let calls = 0;
    const counting: typeof fetch = (input, init) => {
      calls++;
      return fetch(input, init);
    };
    const result = await indexer(definition([blocked.base], extra), [], counting).test();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unreachable');
    expect(result.error.message).toContain('requires a FlareSolverr proxy');
    expect(calls).toBe(0);
  });

  it('a 403 during search is reported as needing FlareSolverr', async () => {
    const err = await rejection(indexer(definition([blocked.base], extra)).search({ kind: 'search', query: 'x' }));
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain('FlareSolverr');
  });

  it('without the marker a 403 stays an auth error', async () => {
    const err = await rejection(indexer(definition([blocked.base])).search({ kind: 'search', query: 'x' }));
    expect(err.code).toBe('auth');
  });
});

describe('definition test block', () => {
  it('test() requests only the test path', async () => {
    const site = await startSite((req, res) => {
      if (req.url?.startsWith('/latest.php')) {
        serveResults(req, res);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    });
    try {
      const yaml = definition([site.base], 'test:\n  path: latest.php\n  inheritInputs: false\n  inputs: {limit: 5}');
      const result = await indexer(yaml).test();
      expect(result).toMatchObject({ ok: true, releaseCount: 1 });
      expect(site.hits).toEqual(['/latest.php?limit=5']);
    } finally {
      await new Promise<void>((resolve) => site.server.close(() => resolve()));
    }
  });

  it('an empty test listing is a clear failure', async () => {
    const yaml = definition([good.base], 'test:\n  path: browse.php\n  inputs: {q: nothing}').replace('tr.t', 'tr.none');
    const result = await indexer(yaml).test();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Test request succeeded but returned no releases');
  });
});

describe('builtin markers', async () => {
  const catalogue = await loadDefinitionCatalogue();
  it('torlock and 1337x require FlareSolverr; the rest do not', () => {
    for (const id of ['torlock', '1337x']) expect(catalogue.get(id)?.requiresflaresolverr).toBe(true);
    for (const id of ['eztv', 'yts', 'nyaa', 'thepiratebay', 'limetorrents', 'torrentgalaxy']) {
      expect(catalogue.get(id)?.requiresflaresolverr ?? false).toBe(false);
    }
  });

  it('eztv tests against the latest-torrents API listing without a query', () => {
    const test = catalogue.get('eztv')?.test;
    expect(test?.path).toBe('api/get-torrents');
    expect(test?.inheritinputs).toBe(false);
    expect(test?.inputs).not.toHaveProperty('imdb_id');
  });

  it('eztv test() hits the latest listing and parses it', async () => {
    const urls: string[] = [];
    const body = JSON.stringify({
      torrents_count: 1,
      limit: 30,
      page: 1,
      torrents: [
        { title: 'Show S01E01 1080p WEB', torrent_url: 'https://e/1.torrent', hash: 'a'.repeat(40), size_bytes: '1000', date_released_unix: 1709000000, seeds: 5, peers: 1, imdb_id: '1234567', episode_url: 'https://e/ep/1' },
      ],
    });
    const fakeFetch: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const def = catalogue.get('eztv');
    if (!def) throw new Error('missing eztv');
    const result = await createDefinitionIndexer(def, {}, { fetchImpl: fakeFetch, sleep: async () => {} }).test();
    expect(result).toMatchObject({ ok: true, releaseCount: 1 });
    expect(urls).toEqual([`${def.links[0]}api/get-torrents?limit=30&page=1`]);
  });

  it('1337x test() without a proxy names FlareSolverr', async () => {
    const def = catalogue.get('1337x');
    if (!def) throw new Error('missing 1337x');
    const result = await createDefinitionIndexer(def, {}, { fetchImpl: () => Promise.reject(new Error('no network')) }).test();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('1337x is behind Cloudflare and requires a FlareSolverr proxy; attach a FlareSolverr proxy to this indexer');
  });

  it('yts has several mirrors to fall back through', () => {
    expect(catalogue.get('yts')?.links.length).toBeGreaterThanOrEqual(3);
  });
});
