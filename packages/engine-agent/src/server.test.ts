import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStatus, AgentTorrent } from './protocol.js';
import { authed, Cleanup, pack, TOKEN, waitFor, writePack, type Pack } from './test-support.js';

const c = new Cleanup();
afterEach(() => c.run());

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** An agent whose engine seeds `p` from <root>/tv. */
async function seedingAgent(p: Pack = pack()) {
  const a = await c.agent();
  await writePack(join(a.root, 'tv'), p);
  const res = await addTorrentFile(a.url, p, { category: 'tv' });
  expect(res.status).toBe(201);
  await waitFor(() => a.session.getTorrent(p.infoHash)?.state === 'seeding');
  return { ...a, p };
}

function addTorrentFile(url: string, p: Pack, options: Record<string, unknown>, token = TOKEN) {
  const form = new FormData();
  form.set('options', JSON.stringify(options));
  form.set('torrent', new Blob([new Uint8Array(p.torrent)]), 'x.torrent');
  return fetch(`${url}/torrents`, { method: 'POST', headers: { 'x-agent-token': token }, body: form });
}

function get(url: string, path: string, headers: Record<string, string> = {}) {
  return fetch(`${url}${path}`, { headers: authed(headers) });
}

function send(url: string, method: string, path: string, body?: unknown) {
  return fetch(`${url}${path}`, {
    method,
    headers: authed(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('agent authentication', () => {
  it('refuses requests without or with a wrong token', async () => {
    const { url } = await c.agent();
    const none = await fetch(`${url}/status`);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ code: 'unauthorized' });
    expect((await fetch(`${url}/status`, { headers: { 'x-agent-token': 'nope' } })).status).toBe(401);
    expect((await fetch(`${url}/torrents`, { method: 'POST', headers: { 'x-agent-token': 'nope' }, body: '{}' })).status).toBe(401);
  });

  it('accepts the token as x-agent-token or as a Bearer token', async () => {
    const { url } = await c.agent();
    expect((await fetch(`${url}/status`, { headers: { 'x-agent-token': TOKEN } })).status).toBe(200);
    expect((await fetch(`${url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it('an agent with an empty token refuses everything', async () => {
    const { url } = await c.agent({ token: '' });
    expect((await fetch(`${url}/status`, { headers: { 'x-agent-token': '' } })).status).toBe(401);
  });

  it('refuses event sockets without the token', async () => {
    const { url } = await c.agent();
    const closed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${url.replace('http', 'ws')}/events`);
      ws.onopen = () => resolve(false);
      ws.onerror = () => resolve(true);
    });
    expect(closed).toBe(true);
  });
});

describe('agent status and torrents', () => {
  it('reports status with protocol version, bound address and port', async () => {
    const { url, session, root } = await c.agent();
    const status = AgentStatus.parse(await (await get(url, '/status')).json());
    expect(status).toMatchObject({
      protocolVersion: 1,
      kind: 'standalone',
      running: true,
      listenAddress: '127.0.0.1',
      listenPort: session.listenPort,
      downloadsRoot: root,
      vpn: { interface: null, up: null },
      portManaged: false,
      torrents: 0,
    });
  });

  it('adds a .torrent by multipart upload and seeds the payload already in place', async () => {
    const { url, p, root } = await seedingAgent();
    const list = AgentTorrent.array().parse(await (await get(url, '/torrents')).json());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: p.infoHash,
      name: p.name,
      state: 'seeding',
      category: 'tv',
      isComplete: true,
      progress: 1,
      totalBytes: 65_000,
      contentPath: join(root, 'tv', p.name),
      seedLimitsMet: false,
    });
  });

  it('adds by magnet, reports duplicates and filters by category', async () => {
    const { url } = await c.agent();
    const p = pack();
    const first = await send(url, 'POST', '/torrents', { magnet: p.magnet, category: 'movies', paused: true });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ id: p.infoHash, duplicate: false });
    const again = await send(url, 'POST', '/torrents', { magnet: p.magnet, category: 'movies' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: p.infoHash, duplicate: true });
    expect(await (await get(url, '/torrents?category=movies')).json()).toHaveLength(1);
    expect(await (await get(url, '/torrents?category=tv')).json()).toHaveLength(0);
    const one = AgentTorrent.parse(await (await get(url, `/torrents/${p.infoHash}`)).json());
    expect(one).toMatchObject({ hasMetadata: false, isComplete: false, state: 'paused' });
  });

  it('rejects bad add requests', async () => {
    const { url } = await c.agent();
    expect((await send(url, 'POST', '/torrents', {})).status).toBe(400);
    expect((await send(url, 'POST', '/torrents', { magnet: 'magnet:?xt=urn:btih:zz' })).status).toBe(400);
    const bad = await fetch(`${url}/torrents`, { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: '{' });
    expect(bad.status).toBe(400);
    const outside = await send(url, 'POST', '/torrents', { magnet: pack().magnet, savePath: '/etc' });
    expect(outside.status).toBe(403);
  });

  it('answers 404 for unknown torrents and routes', async () => {
    const { url } = await c.agent();
    expect((await get(url, `/torrents/${'a'.repeat(40)}`)).status).toBe(404);
    expect((await get(url, '/torrents/not-a-hash')).status).toBe(404);
    expect((await get(url, '/nope')).status).toBe(404);
  });

  it('pauses, resumes, changes category and moves storage inside the root only', async () => {
    const { url, session, p, root } = await seedingAgent();
    expect((await send(url, 'POST', `/torrents/${p.infoHash}/pause`)).status).toBe(204);
    expect(session.getTorrent(p.infoHash)?.state).toBe('paused');
    expect((await send(url, 'POST', `/torrents/${p.infoHash}/resume`)).status).toBe(204);
    await waitFor(() => session.getTorrent(p.infoHash)?.state === 'seeding');
    expect((await send(url, 'PUT', `/torrents/${p.infoHash}/category`, { category: 'done' })).status).toBe(204);
    expect(session.getTorrent(p.infoHash)?.category).toBe('done');
    expect((await send(url, 'PUT', `/torrents/${p.infoHash}/save-path`, { savePath: join(root, '..') })).status).toBe(403);
    expect((await send(url, 'PUT', `/torrents/${p.infoHash}/save-path`, { savePath: join(root, 'moved') })).status).toBe(204);
    expect(await readFile(join(root, 'moved', p.name, 'a.bin'))).toEqual(p.files[0]!.data);
  });

  it('removes a torrent, deleting its data on request', async () => {
    const { url, session, p, root } = await seedingAgent();
    expect((await send(url, 'DELETE', `/torrents/${p.infoHash}?deleteData=true`)).status).toBe(204);
    expect(session.getTorrent(p.infoHash)).toBeUndefined();
    await waitFor(async () => !(await exists(join(root, 'tv', p.name, 'a.bin'))));
  });

  it('sets the listen port unless the agent manages it', async () => {
    const { url, session } = await c.agent();
    const res = await send(url, 'PUT', '/listen-port', { port: 0 });
    expect(res.status).toBe(400);
    const { freePort } = await import('./test-ports.js');
    const port = await freePort();
    const ok = await send(url, 'PUT', '/listen-port', { port });
    expect(ok.status).toBe(200);
    expect(AgentStatus.parse(await ok.json()).listenPort).toBe(port);
    expect(session.listenPort).toBe(port);

    const managed = await c.agent({ core: { portManaged: () => true } });
    const refused = await send(managed.url, 'PUT', '/listen-port', { port });
    expect(refused.status).toBe(409);
  });
});

describe('agent file transfer', () => {
  it('lists files and serves a complete file in full', async () => {
    const { url, p } = await seedingAgent();
    const files = await (await get(url, `/torrents/${p.infoHash}/files`)).json();
    expect(files).toEqual([
      { index: 0, path: `${p.name}/a.bin`, length: 40_000, priority: 1, progress: 1, complete: true },
      { index: 1, path: `${p.name}/sub/f1.bin`, length: 25_000, priority: 1, progress: 1, complete: true },
    ]);
    const res = await get(url, `/torrents/${p.infoHash}/files/1/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(p.files[1]!.data);
  });

  it('serves byte ranges (open-ended, bounded, suffix) and refuses bad ones', async () => {
    const { url, p } = await seedingAgent();
    const path = `/torrents/${p.infoHash}/files/0/content`;
    const data = p.files[0]!.data;
    const open = await get(url, path, { range: 'bytes=39000-' });
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe('bytes 39000-39999/40000');
    expect(Buffer.from(await open.arrayBuffer())).toEqual(data.subarray(39_000));
    const bounded = await get(url, path, { range: 'bytes=10-19' });
    expect(Buffer.from(await bounded.arrayBuffer())).toEqual(data.subarray(10, 20));
    const suffix = await get(url, path, { range: 'bytes=-5' });
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(data.subarray(39_995));
    const atEnd = await get(url, path, { range: 'bytes=40000-' });
    expect(atEnd.status).toBe(206);
    expect((await atEnd.arrayBuffer()).byteLength).toBe(0);
    expect((await get(url, path, { range: 'bytes=50000-' })).status).toBe(416);
    expect((await get(url, path, { range: 'items=1-2' })).status).toBe(416);
    const head = await fetch(`${url}${path}`, { method: 'HEAD', headers: authed() });
    expect(head.headers.get('content-length')).toBe('40000');
  });

  it('serves the SHA-256 of a complete file', async () => {
    const { url, p } = await seedingAgent();
    const res = await get(url, `/torrents/${p.infoHash}/files/1/sha256`);
    expect(await res.json()).toEqual({ index: 1, length: 25_000, sha256: createHash('sha256').update(p.files[1]!.data).digest('hex') });
    expect((await get(url, `/torrents/${p.infoHash}/files/9/sha256`)).status).toBe(404);
  });

  it('refuses files that are not completely downloaded', async () => {
    const { url, session } = await c.agent();
    const p = pack();
    expect((await addTorrentFile(url, p, { category: 'tv', paused: true })).status).toBe(201);
    await waitFor(() => session.getTorrent(p.infoHash)?.state === 'paused');
    const files = await (await get(url, `/torrents/${p.infoHash}/files`)).json();
    expect(files[0]).toMatchObject({ complete: false, progress: 0 });
    const res = await get(url, `/torrents/${p.infoHash}/files/0/content`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'incomplete' });
  });
});

describe('agent event stream', () => {
  it('sends hello, then added / stateChange / removed events', async () => {
    const { url, root } = await c.agent();
    const events: Array<{ type: string }> = [];
    const ws = new WebSocket(`${url.replace('http', 'ws')}/events`, { headers: authed() } as unknown as string[]);
    c.add(() => ws.close());
    ws.onmessage = (m) => events.push(JSON.parse(String(m.data)));
    await waitFor(() => events.some((e) => e.type === 'hello'));
    const p = pack();
    await writePack(join(root, 'tv'), p);
    await addTorrentFile(url, p, { category: 'tv' });
    await waitFor(() => events.some((e) => e.type === 'stateChange' && (e as { next?: string }).next === 'seeding'));
    await send(url, 'DELETE', `/torrents/${p.infoHash}`);
    await waitFor(() => events.some((e) => e.type === 'removed'));
    expect(events[0]!.type).toBe('hello');
    expect(events.map((e) => e.type)).toContain('added');
  });
});
