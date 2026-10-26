import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTorrent } from './create.js';
import { completed, payload, payloadMatches, TestEnv, waitFor, writePayload } from './test-utils.js';
import { webSeedFileUrl } from './webseed.js';

const env = new TestEnv();
afterEach(() => env.cleanup());

interface WebServer {
  base: string;
  requests: { url: string; range: string | undefined; local: string | undefined }[];
  maxConcurrent: number;
  /** Respond 503 to this many requests first. */
  failFirst: number;
}

/** Static file server with Range support over `root`. */
async function webServer(root: string): Promise<WebServer> {
  const state: WebServer = { base: '', requests: [], maxConcurrent: 0, failFirst: 0 };
  let active = 0;
  const server = http.createServer(async (req, res) => {
    active++;
    state.maxConcurrent = Math.max(state.maxConcurrent, active);
    res.on('close', () => active--);
    state.requests.push({ url: req.url ?? '', range: req.headers.range, local: req.socket.remoteAddress });
    if (state.failFirst > 0) {
      state.failFirst--;
      res.writeHead(503).end();
      return;
    }
    let data: Buffer;
    try {
      const parts = (req.url ?? '/').split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
      data = await readFile(join(root, ...parts));
    } catch {
      res.writeHead(404).end();
      return;
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    // a little latency so concurrent requests overlap
    await new Promise((r) => setTimeout(r, 5));
    if (!m) {
      res.writeHead(200, { 'content-length': data.length }).end(data);
      return;
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), data.length - 1);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1 }).end(data.subarray(start, end + 1));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  env.defer(() => new Promise<void>((r) => server.close(() => r())));
  env.defer(() => server.closeAllConnections());
  return state;
}

describe('web seed URLs', () => {
  it('builds GetRight-style file URLs', () => {
    const multi = { name: 'My Pack', isMultiFile: true };
    expect(webSeedFileUrl('http://h/files/', multi, { pathSegments: ['My Pack', 'dir', 'a b.bin'] })).toBe('http://h/files/My%20Pack/dir/a%20b.bin');
    expect(webSeedFileUrl('http://h/files', multi, { pathSegments: ['My Pack', 'x'] })).toBe('http://h/files/My%20Pack/x');
    const single = { name: 'f.iso', isMultiFile: false };
    expect(webSeedFileUrl('http://h/dl/', single, { pathSegments: ['f.iso'] })).toBe('http://h/dl/f.iso');
    expect(webSeedFileUrl('http://h/exact/name.iso', single, { pathSegments: ['f.iso'] })).toBe('http://h/exact/name.iso');
  });
});

describe('web seeds (BEP 19)', () => {
  it('downloads a multi-file torrent from an HTTP server alone, within the connection cap', async () => {
    const p = payload();
    const root = await env.tmp();
    await writePayload(root, 'pack', p);
    const web = await webServer(root);
    const { torrent } = createTorrent({ name: 'pack', files: p.files, pieceLength: 32 * 1024, urlList: [web.base] });
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir, webSeedConnectionsPerTorrent: 2 });
    const lt = await leecher.addTorrent({ torrent });
    await waitFor(() => lt.getWebSeeds().length === 1);
    await completed(lt);
    expect(await payloadMatches(dir, 'pack', p)).toBe(true);
    expect(web.requests.length).toBeGreaterThan(5);
    expect(web.requests.every((r) => r.range?.startsWith('bytes='))).toBe(true);
    expect(web.requests.some((r) => r.url === '/pack/dir/c.bin')).toBe(true);
    expect(web.maxConcurrent).toBeLessThanOrEqual(2);
    // every request came from the bound listen address
    expect(web.requests.every((r) => r.local?.endsWith('127.0.0.1'))).toBe(true);
    expect(lt.getStats().downloaded).toBeGreaterThanOrEqual(lt.getStats().totalBytes);
  }, 30_000);

  it('backs off after server errors and then recovers', async () => {
    const p = payload();
    const root = await env.tmp();
    await writePayload(root, 'pack', p);
    const web = await webServer(root);
    web.failFirst = 3;
    const { torrent } = createTorrent({ name: 'pack', files: p.files, pieceLength: 32 * 1024, urlList: [web.base] });
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir, webSeedConnectionsPerTorrent: 1, webSeedRetryMs: 100 });
    const lt = await leecher.addTorrent({ torrent });
    const backingOff = await waitFor(() => lt.getWebSeeds().find((w) => w.failures > 0));
    expect(backingOff.lastError).toMatch(/503/);
    expect(backingOff.retryAt).not.toBeNull();
    await completed(lt);
    expect(await payloadMatches(dir, 'pack', p)).toBe(true);
    expect(lt.getWebSeeds()).toEqual([]); // stopped once complete
  }, 30_000);

  it('downloads from peers and a web seed together', async () => {
    const { p, seeder, seedDir } = await env.seed();
    // same payload served over HTTP
    const web = await webServer(seedDir);
    const withWs = createTorrent({ name: 'pack', files: p.files, pieceLength: 32 * 1024, urlList: [web.base] });
    // the seeder has a different torrent (no url-list) but the same info dict: same info-hash
    expect(withWs.metainfo.infoHashHex).toBe(createTorrent({ name: 'pack', files: p.files, pieceLength: 32 * 1024 }).metainfo.infoHashHex);
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir, downloadLimit: 400_000 });
    const lt = await leecher.addTorrent({ torrent: withWs.torrent, peers: [{ host: '127.0.0.1', port: seeder.listenPort }] });
    await completed(lt);
    expect(await payloadMatches(dir, 'pack', p)).toBe(true);
    expect(web.requests.length).toBeGreaterThan(0);
  }, 30_000);
});
