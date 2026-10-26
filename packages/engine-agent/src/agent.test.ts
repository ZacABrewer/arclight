import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startAgent } from './agent.js';
import { AgentClient } from './client.js';
import { AgentConfigError, parseAgentEnv } from './config.js';
import { multipartBoundary, parseMultipart } from './multipart.js';
import { LOCKDOWN_ADDRESS, NetworkFollower } from './network.js';
import { Cleanup, FAST, pack, TOKEN, waitFor, writePack } from './test-support.js';

const c = new Cleanup();
afterEach(() => c.run());

const quiet = () => {};

describe('parseAgentEnv', () => {
  it('requires a token of at least 16 characters', () => {
    expect(() => parseAgentEnv({})).toThrow(AgentConfigError);
    expect(() => parseAgentEnv({ AGENT_TOKEN: 'short' })).toThrow(/16 characters/);
  });

  it('fills defaults and maps engine flags', () => {
    const cfg = parseAgentEnv({
      AGENT_TOKEN: TOKEN,
      AGENT_DOWNLOADS: '/srv/dl',
      AGENT_DATA: '/srv/data',
      AGENT_LISTEN_ADDRESS: '10.2.0.2',
      AGENT_LISTEN_PORT: '51413',
      AGENT_ENCRYPTION: 'required',
      AGENT_UTP: '0',
      AGENT_DOWNLOAD_LIMIT_KBPS: '100',
      AGENT_SEED_TIME_MINUTES: '60',
    });
    expect(cfg).toMatchObject({ port: 7879, host: '0.0.0.0', listenPort: 51413, listenAddress: '10.2.0.2', listenInterface: null, portFile: null });
    expect(cfg.resumeDir).toBe(resolve('/srv/data', 'resume'));
    expect(cfg.downloadsRoot).toBe(resolve('/srv/dl'));
    expect(cfg.session).toMatchObject({ encryption: 'required', utp: false, tcp: true, downloadLimit: 102_400, seedTimeLimitMs: 3_600_000, seedRatioLimit: null });
  });

  it('rejects invalid values with the variable name', () => {
    expect(() => parseAgentEnv({ AGENT_TOKEN: TOKEN, AGENT_PORT: '99999' })).toThrow(/AGENT_PORT/);
    expect(() => parseAgentEnv({ AGENT_TOKEN: TOKEN, AGENT_ENCRYPTION: 'maybe' })).toThrow(/AGENT_ENCRYPTION/);
    expect(() => parseAgentEnv({ AGENT_TOKEN: TOKEN, AGENT_UTP: 'perhaps' })).toThrow(/AGENT_UTP/);
  });
});

describe('parseMultipart', () => {
  it('splits a form built by fetch', async () => {
    const form = new FormData();
    form.set('options', '{"category":"tv"}');
    form.set('torrent', new Blob([new Uint8Array([0, 13, 10, 45, 45, 255])]), 'a.torrent');
    const req = new Request('http://x', { method: 'POST', body: form });
    const boundary = multipartBoundary(req.headers.get('content-type') ?? undefined);
    expect(boundary).toBeTruthy();
    const parts = parseMultipart(Buffer.from(await req.arrayBuffer()), boundary!);
    expect(parts.map((p) => p.name)).toEqual(['options', 'torrent']);
    expect(parts[0]!.data.toString()).toBe('{"category":"tv"}');
    expect([...parts[1]!.data]).toEqual([0, 13, 10, 45, 45, 255]);
    expect(parts[1]!.filename).toBe('a.torrent');
  });

  it('rejects truncated bodies', () => {
    expect(() => parseMultipart(Buffer.from('--b\r\ncontent-disposition: form-data; name="x"\r\n\r\nabc'), 'b')).toThrow();
    expect(multipartBoundary('application/json')).toBeNull();
  });
});

describe('NetworkFollower', () => {
  it('binds to the interface address, locks down when it disappears and follows the port file', async () => {
    const session = await c.session({ listenAddress: null });
    let present = true;
    let portFile = '';
    const follower = new NetworkFollower({
      session,
      interfaceName: 'tun0',
      portFile: '/tmp/forwarded_port',
      pollMs: 60_000,
      interfaces: () =>
        present ? { tun0: [{ address: '127.0.0.1', family: 'IPv4', internal: false, netmask: '255.0.0.0', mac: '', cidr: null }] } : {},
      readPortFile: async () => portFile,
    });
    await follower.check();
    expect(session.settings.listenAddress).toBe('127.0.0.1');
    expect(follower.state()).toEqual({ interface: 'tun0', up: true });
    expect(follower.portManaged()).toBe(true);

    present = false;
    await follower.check();
    expect(session.settings.listenAddress).toBe(LOCKDOWN_ADDRESS);
    expect(follower.state().up).toBe(false);

    const { freePort } = await import('./test-ports.js');
    const port = await freePort();
    portFile = `${port}\n`;
    await follower.check();
    expect(session.listenPort).toBe(port);
  });
});

describe('startAgent', () => {
  it('serves the API, persists resume data and restores torrents after a restart', async () => {
    const downloads = await c.tmp();
    const data = await c.tmp();
    const config = parseAgentEnv({ AGENT_TOKEN: TOKEN, AGENT_PORT: '1', AGENT_DOWNLOADS: downloads, AGENT_DATA: data, AGENT_LISTEN_ADDRESS: '127.0.0.1', AGENT_LISTEN_PORT: '0', AGENT_DHT: '0' });
    const cfg = { ...config, port: 0, host: '127.0.0.1', session: { ...config.session, ...FAST, listenPort: 0, savePath: downloads, resumeDataDir: config.resumeDir } };

    const first = await startAgent(cfg, { log: quiet });
    let stopped = false;
    c.add(() => (stopped ? undefined : first.stop()));
    const p = pack();
    await writePack(join(downloads, 'tv'), p);
    const client = new AgentClient({ url: `http://127.0.0.1:${first.address.port}`, token: TOKEN });
    await client.add({ category: 'tv' }, p.torrent);
    await waitFor(async () => (await client.get(p.infoHash)).state === 'seeding');
    await first.stop();
    stopped = true;

    const second = await startAgent(cfg, { log: quiet });
    c.add(() => second.stop());
    const again = new AgentClient({ url: `http://127.0.0.1:${second.address.port}`, token: TOKEN });
    await waitFor(async () => (await again.list()).some((t) => t.id === p.infoHash && t.state === 'seeding'));
    expect((await again.get(p.infoHash)).category).toBe('tv');
  });
});
