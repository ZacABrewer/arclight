import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient, AgentClientError } from './client.js';
import { EngineAgentCore } from './core.js';
import type { AgentEvent } from './protocol.js';
import { createAgentServer } from './server.js';
import { Cleanup, pack, TOKEN, waitFor, writePack } from './test-support.js';

const c = new Cleanup();
afterEach(() => c.run());

async function codeOf(p: Promise<unknown>): Promise<string> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AgentClientError);
  return (error as AgentClientError).code;
}

describe('AgentClient', () => {
  it('drives every endpoint of a live agent', async () => {
    const { url, root, session } = await c.agent();
    const client = new AgentClient({ url: `${url}/`, token: TOKEN });
    expect((await client.status()).protocolVersion).toBe(1);
    const p = pack();
    await writePack(join(root, 'tv'), p);
    expect(await client.add({ category: 'tv' }, p.torrent)).toEqual({ id: p.infoHash, duplicate: false });
    await waitFor(() => session.getTorrent(p.infoHash)?.state === 'seeding');
    expect((await client.list('tv')).map((t) => t.id)).toEqual([p.infoHash]);
    expect((await client.files(p.infoHash)).every((f) => f.complete)).toBe(true);
    const res = await client.openFile(p.infoHash, 0, 39_990);
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(p.files[0]!.data.subarray(39_990));
    await client.pause(p.infoHash);
    await client.setCategory(p.infoHash, 'x');
    expect(await client.get(p.infoHash)).toMatchObject({ state: 'paused', category: 'x' });
    await client.resume(p.infoHash);
    await client.remove(p.infoHash, false);
    expect(await client.list()).toEqual([]);
  });

  it('maps a wrong token to auth and a dead agent to unreachable', async () => {
    const { url } = await c.agent();
    expect(await codeOf(new AgentClient({ url, token: 'wrong' }).status())).toBe('auth');
    expect(await codeOf(new AgentClient({ url: 'http://127.0.0.1:1', token: TOKEN, timeoutMs: 2000 }).status())).toBe('unreachable');
  });

  it('maps agent error codes (not-found, rejected, conflict)', async () => {
    const managed = await c.agent({ core: { portManaged: () => true } });
    const client = new AgentClient({ url: managed.url, token: TOKEN });
    expect(await codeOf(client.get('a'.repeat(40)))).toBe('not-found');
    expect(await codeOf(client.add({ magnet: 'magnet:?xt=urn:btih:bad' }))).toBe('rejected');
    expect(await codeOf(client.setListenPort(40000))).toBe('conflict');
  });

  it('refuses agents speaking another protocol version', async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ protocolVersion: 2 }), { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await codeOf(new AgentClient({ url: 'http://x', token: TOKEN, fetch: fake }).status())).toBe('bad-response');
  });

  it('streams events with a hello first', async () => {
    const { url, root } = await c.agent();
    const client = new AgentClient({ url, token: TOKEN });
    const events: AgentEvent[] = [];
    const sub = client.subscribe((e) => events.push(e));
    c.add(() => sub.close());
    await waitFor(() => sub.connected && events[0]?.type === 'hello');
    const p = pack();
    await writePack(join(root, 'tv'), p);
    await client.add({ category: 'tv' }, p.torrent);
    await waitFor(() => events.find((e) => e.type === 'completed' || (e.type === 'stateChange' && e.next === 'seeding')));
  });

  it('reconnects after the agent restarts on the same port', async () => {
    const root = await c.tmp();
    const session = await c.session({ savePath: root });
    const core = new EngineAgentCore({ session, downloadsRoot: root, kind: 'standalone' });
    let server = createAgentServer({ core, token: TOKEN });
    const { port } = await server.listen(0, '127.0.0.1');
    const client = new AgentClient({ url: `http://127.0.0.1:${port}`, token: TOKEN });
    let opens = 0;
    const closes: string[] = [];
    const hellos: AgentEvent[] = [];
    const sub = client.subscribe((e) => e.type === 'hello' && hellos.push(e), {
      backoffMs: 50,
      maxBackoffMs: 200,
      onOpen: () => opens++,
      onClose: (r) => closes.push(r),
    });
    c.add(() => sub.close());
    await waitFor(() => opens === 1 && hellos.length === 1);
    await server.close();
    await waitFor(() => !sub.connected && closes.length >= 1);
    // A few failed attempts while the agent is down, then it comes back.
    await new Promise((r) => setTimeout(r, 150));
    server = createAgentServer({ core, token: TOKEN });
    await server.listen(port, '127.0.0.1');
    c.add(() => server.close());
    await waitFor(() => opens === 2 && hellos.length === 2 && sub.connected);
    sub.close();
    await waitFor(() => !sub.connected);
  });
});
