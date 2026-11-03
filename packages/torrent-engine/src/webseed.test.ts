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

/** True when a run of the 0x5a "bad seed" filler is in any payload file under `dir`. */
async function anyBadBytesOnDisk(dir: string, p: ReturnType<typeof payload>): Promise<boolean> {
  const run = Buffer.alloc(64, 0x5a);
  for (const f of p.files) {
    const data = await readFile(join(dir, 'pack', ...f.path)).catch(() => null);
    if (data?.includes(run)) return true;
  }
  return false;
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

  it('refuses loopback / LAN web seeds unless allowLocalTrackers is on (DATA-11)', async () => {
    const p = payload();
    const root = await env.tmp();
    await writePayload(root, 'pack', p);
    const web = await webServer(root);
    const { torrent } = createTorrent({ name: 'pack', files: p.files, pieceLength: 32 * 1024, urlList: [web.base] });
    const leecher = await env.session({ savePath: await env.tmp(), allowLocalTrackers: false, webSeedRetryMs: 50 });
    const lt = await leecher.addTorrent({ torrent });
    const refused = await waitFor(() => lt.getWebSeeds().find((w) => w.failures > 0));
    expect(refused.lastError).toMatch(/local or reserved/);
    await new Promise((r) => setTimeout(r, 300));
    expect(web.requests).toHaveLength(0);
  });

  it('disables a web seed whose data keeps failing the hash check (DATA-24)', async () => {
    const p = payload();
    const root = await env.tmp();
    // Serve the right sizes with the wrong bytes.
    await writePayload(root, 'pack', { files: p.files.map((f) => ({ path: f.path, data: Buffer.alloc(f.data.length, 0x5a) })) });
    const web = await webServer(root);
    const { torrent } = createTorrent({ name: 'pack', files: p.files, pieceLength: 32 * 1024, urlList: [web.base] });
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir, webSeedConnectionsPerTorrent: 1 });
    const lt = await leecher.addTorrent({ torrent });
    const off = await waitFor(() => lt.getWebSeeds().find((w) => /disabled/.test(w.lastError ?? '')));
    expect(off.retryAt).toBeNull();
    const seen = web.requests.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(web.requests.length).toBe(seen);
    expect(lt.hashFailureCount).toBeGreaterThanOrEqual(3);
    // The bad bytes were checked in memory and dropped: none of them reached the disk.
    expect(await anyBadBytesOnDisk(dir, p)).toBe(false);
  }, 30_000);

  it('never writes a web seed piece that fails the hash check, and a good seed still completes (DATA-11)', async () => {
    const p = payload();
    const badRoot = await env.tmp();
    await writePayload(badRoot, 'pack', { files: p.files.map((f) => ({ path: f.path, data: Buffer.alloc(f.data.length, 0x5a) })) });
    const bad = await webServer(badRoot);
    const { torrent } = createTorrent({ name: 'pack', files: p.files, pieceLength: 32 * 1024, urlList: [bad.base] });
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir, webSeedConnectionsPerTorrent: 1 });
    const lt = await leecher.addTorrent({ torrent });
    const warned: string[] = [];
    lt.on('warning', (m) => warned.push(m));
    await waitFor(() => lt.hashFailureCount >= 1);
    expect(warned.some((w) => /from a web seed failed hash check/.test(w))).toBe(true);
    expect(await anyBadBytesOnDisk(dir, p)).toBe(false);
    expect(lt.getStats().downloaded).toBeGreaterThan(0);
    await leecher.removeTorrent(lt.infoHashHex, false);

    // Same torrent, a bad and a good seed: completes with the right bytes.
    const goodRoot = await env.tmp();
    await writePayload(goodRoot, 'pack', p);
    const good = await webServer(goodRoot);
    const both = createTorrent({ name: 'pack', files: p.files, pieceLength: 32 * 1024, urlList: [bad.base, good.base] });
    const dir2 = await env.tmp();
    const leecher2 = await env.session({ savePath: dir2, webSeedConnectionsPerTorrent: 2 });
    const lt2 = await leecher2.addTorrent({ torrent: both.torrent });
    await completed(lt2);
    expect(await payloadMatches(dir2, 'pack', p)).toBe(true);
    expect(good.requests.length).toBeGreaterThan(0);
  }, 30_000);

  it('does not use web seeds for pieces over the in-memory limit', async () => {
    const p = payload();
    const root = await env.tmp();
    await writePayload(root, 'pack', p);
    const web = await webServer(root);
    const { torrent } = createTorrent({ name: 'pack', files: p.files, pieceLength: 64 * 1024 * 1024, urlList: [web.base] });
    const leecher = await env.session({ savePath: await env.tmp() });
    const lt = await leecher.addTorrent({ torrent });
    const ws = await waitFor(() => lt.getWebSeeds().find((w) => w.lastError));
    expect(ws.lastError).toMatch(/over 32 MiB/);
    await new Promise((r) => setTimeout(r, 300));
    expect(web.requests).toHaveLength(0);
  });

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
