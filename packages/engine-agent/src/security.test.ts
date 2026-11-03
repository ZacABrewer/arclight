import { execFileSync } from 'node:child_process';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startAgent } from './agent.js';
import { AgentClient, AgentClientError } from './client.js';
import { agentSecurityWarnings, AgentConfigError, parseAgentEnv, tokenWeakness } from './config.js';
import { AgentError, EngineAgentCore } from './core.js';
import { AGENT_DEPRECATION_HEADER } from './protocol.js';
import { handleAgentRequest } from './router.js';
import { AuthThrottle } from './throttle.js';
import { Cleanup, FAST, pack, TOKEN, waitFor, writePack } from './test-support.js';

// DATA-17 / DATA-18 / DATA-27 / DATA-55: transport security, token handling, root containment
// through symbolic links, and the router's handling of malformed paths. Loopback only.

const c = new Cleanup();
afterEach(() => c.run());

function listen(handler: (req: IncomingMessage, body: Buffer) => { status: number; headers?: Record<string, string>; body?: unknown }): Promise<{ url: string; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      seen.push(req);
      const out = handler(req, Buffer.concat(chunks));
      res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
      res.end(out.body === undefined ? '' : JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      c.add(() => new Promise<void>((done) => server.close(() => done())));
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen });
    });
  });
}

describe('AuthThrottle', () => {
  it('lets the first failures through, then blocks for doubling times', () => {
    let now = 0;
    const t = new AuthThrottle({ freeFailures: 2, baseMs: 1000, maxMs: 4000, now: () => now });
    t.fail('10.0.0.2');
    t.fail('10.0.0.2');
    expect(t.retryAfterMs('10.0.0.2')).toBe(0);
    t.fail('10.0.0.2');
    expect(t.retryAfterMs('10.0.0.2')).toBe(1000);
    expect(t.retryAfterMs('::ffff:10.0.0.2')).toBe(1000);
    expect(t.retryAfterMs('10.0.0.3')).toBe(0);
    t.fail('10.0.0.2');
    expect(t.retryAfterMs('10.0.0.2')).toBe(2000);
    t.fail('10.0.0.2');
    t.fail('10.0.0.2');
    expect(t.retryAfterMs('10.0.0.2')).toBe(4000);
    now = 4000;
    expect(t.retryAfterMs('10.0.0.2')).toBe(0);
    t.succeed('10.0.0.2');
    t.fail('10.0.0.2');
    expect(t.retryAfterMs('10.0.0.2')).toBe(0);
  });

  it('tracks a bounded number of addresses', () => {
    const t = new AuthThrottle({ maxEntries: 3 });
    for (let i = 0; i < 10; i++) t.fail(`10.0.0.${i}`);
    expect(t.size).toBe(3);
  });
});

describe('agent server: failed-auth back-off', () => {
  it('answers 429 with retry-after after repeated bad tokens, also to the right token', async () => {
    const { url } = await c.agent({ server: { throttle: new AuthThrottle({ freeFailures: 2, baseMs: 60_000 }) } });
    for (let i = 0; i < 3; i++) expect((await fetch(`${url}/status`, { headers: { 'x-agent-token': 'wrong-token-guess' } })).status).toBe(401);
    const blocked = await fetch(`${url}/status`, { headers: { 'x-agent-token': TOKEN } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({ code: 'rate-limited' });
    const client = new AgentClient({ url, token: TOKEN });
    const error = await client.status().catch((e: unknown) => e);
    expect((error as AgentClientError).code).toBe('auth');
  });
});

describe('agent configuration security', () => {
  it('warns about plain HTTP on a non-loopback bind, not on loopback, TLS or an acknowledged private network', () => {
    const base = { token: TOKEN, tls: null, insecureOk: false };
    expect(agentSecurityWarnings({ ...base, host: '0.0.0.0' }).join(' ')).toMatch(/plain HTTP/);
    expect(agentSecurityWarnings({ ...base, host: '10.0.0.5' }).join(' ')).toMatch(/plain HTTP/);
    expect(agentSecurityWarnings({ ...base, host: '127.0.0.1' })).toEqual([]);
    expect(agentSecurityWarnings({ ...base, host: '::1' })).toEqual([]);
    expect(agentSecurityWarnings({ ...base, host: '0.0.0.0', tls: { certPath: 'c', keyPath: 'k' } })).toEqual([]);
    expect(agentSecurityWarnings({ ...base, host: '0.0.0.0', insecureOk: true })).toEqual([]);
  });

  it('keeps accepting existing 16+ character tokens, warns about weak ones and refuses only clearly unsafe ones', () => {
    expect(parseAgentEnv({ AGENT_TOKEN: '0123456789abcdef' }).token).toBe('0123456789abcdef');
    expect(tokenWeakness('0123456789abcdef')).toBeNull();
    expect(tokenWeakness('f3a9c2e81b7d4056aa91c3e7b2d8f014')).toBeNull();
    expect(tokenWeakness('change-me-to-a-long-secret')).toMatch(/placeholder/);
    expect(tokenWeakness('abcabcabcabcabcabc')).toMatch(/different characters|repeated/);
    expect(tokenWeakness('1234123412341234')).toMatch(/different characters|repeated/);
    expect(parseAgentEnv({ AGENT_TOKEN: 'change-me-to-a-long-secret' }).token).toBe('change-me-to-a-long-secret');
    expect(() => parseAgentEnv({ AGENT_TOKEN: 'aaaaaaaaaaaaaaaaaaaa' })).toThrow(AgentConfigError);
    expect(() => parseAgentEnv({ AGENT_TOKEN: 'abababababababababab' })).toThrow(/not a secret/);
    expect(agentSecurityWarnings({ token: 'change-me-to-a-long-secret', host: '127.0.0.1', tls: null, insecureOk: false }).join(' ')).toMatch(/AGENT_TOKEN is weak/);
  });

  it('needs both TLS paths and reads the opt-out flag', () => {
    expect(() => parseAgentEnv({ AGENT_TOKEN: TOKEN, AGENT_TLS_CERT: '/x/cert.pem' })).toThrow(/AGENT_TLS_KEY/);
    const cfg = parseAgentEnv({ AGENT_TOKEN: TOKEN, AGENT_TLS_CERT: '/x/cert.pem', AGENT_TLS_KEY: '/x/key.pem', AGENT_INSECURE_OK: '1' });
    expect(cfg.tls).not.toBeNull();
    expect(cfg.insecureOk).toBe(true);
    expect(parseAgentEnv({ AGENT_TOKEN: TOKEN }).tls).toBeNull();
  });

  it('startAgent logs the security warnings', async () => {
    const downloads = await c.tmp();
    const data = await c.tmp();
    const config = parseAgentEnv({ AGENT_TOKEN: 'change-me-to-a-long-secret', AGENT_DOWNLOADS: downloads, AGENT_DATA: data, AGENT_DHT: '0' });
    const cfg = { ...config, port: 0, host: '127.0.0.1', session: { ...config.session, ...FAST, listenPort: 0, savePath: downloads, resumeDataDir: config.resumeDir } };
    const logged: string[] = [];
    const agent = await startAgent(cfg, { log: (level, msg) => logged.push(`${level}: ${msg}`) });
    c.add(() => agent.stop());
    expect(logged.some((l) => l.startsWith('warn: SECURITY: AGENT_TOKEN is weak'))).toBe(true);
  });

  it('serves HTTPS with AGENT_TLS_CERT / AGENT_TLS_KEY', async (ctx) => {
    const dir = await c.tmp();
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    } catch {
      ctx.skip();
      return;
    }
    const downloads = await c.tmp();
    const config = parseAgentEnv({ AGENT_TOKEN: TOKEN, AGENT_DOWNLOADS: downloads, AGENT_DATA: dir, AGENT_DHT: '0', AGENT_TLS_CERT: cert, AGENT_TLS_KEY: key });
    const cfg = { ...config, port: 0, host: '127.0.0.1', session: { ...config.session, ...FAST, listenPort: 0, savePath: downloads, resumeDataDir: config.resumeDir } };
    const agent = await startAgent(cfg, { log: () => {} });
    c.add(() => agent.stop());
    const ca = await readFile(cert);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpsRequest(
        { host: '127.0.0.1', port: agent.address.port, path: '/status', headers: { 'x-agent-token': TOKEN }, ca, servername: 'localhost' },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });
});

describe('agent client: what it sends and follows', () => {
  it('sends the token only as x-agent-token and does not follow redirects', async () => {
    const target = await listen(() => ({ status: 200, body: {} }));
    const redirecting = await listen(() => ({ status: 302, headers: { location: `${target.url}/status` } }));
    const client = new AgentClient({ url: redirecting.url, token: TOKEN });
    const error = await client.status().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentClientError);
    expect((error as AgentClientError).code).toBe('bad-response');
    expect((error as AgentClientError).message).toMatch(/redirect/);
    expect(target.seen).toHaveLength(0);
    expect(redirecting.seen[0]!.headers['x-agent-token']).toBe(TOKEN);
    expect(redirecting.seen[0]!.headers['x-api-key']).toBeUndefined();
  });

  it('falls back to x-api-key for an Arclight from before 0.24 and warns', async () => {
    const { core } = await c.agent();
    const old = await listen((req) => {
      if (req.headers['x-api-key'] !== TOKEN) return { status: 401, body: { error: 'authentication required', code: 'UNAUTHORIZED' } };
      return { status: 200, body: core.status() };
    });
    const client = new AgentClient({ url: `${old.url}/api/v1/engine-agent`, token: TOKEN });
    expect((await client.status()).protocolVersion).toBe(1);
    expect(old.seen[0]!.headers['x-api-key']).toBeUndefined();
    expect(old.seen[1]!.headers['x-agent-token']).toBeUndefined();
    expect(client.warnings().join(' ')).toMatch(/full API key/);
    await client.status();
    expect(old.seen).toHaveLength(3);
  });

  it('does not fall back for a standalone agent, and notes the deprecation header', async () => {
    const standalone = await listen(() => ({ status: 401, body: { error: 'A valid agent token is required.', code: 'unauthorized' } }));
    const client = new AgentClient({ url: standalone.url, token: TOKEN });
    expect(((await client.status().catch((e: unknown) => e)) as AgentClientError).code).toBe('auth');
    expect(standalone.seen).toHaveLength(1);

    const { core } = await c.agent();
    const legacy = await listen(() => ({ status: 200, headers: { [AGENT_DEPRECATION_HEADER]: 'api-key' }, body: core.status() }));
    const viaKey = new AgentClient({ url: `${legacy.url}/api/v1/engine-agent`, token: TOKEN });
    await viaKey.status();
    expect(viaKey.warnings().join(' ')).toMatch(/full API key/);
  });

  it('warns about plain http:// to a non-loopback host only', () => {
    expect(new AgentClient({ url: 'http://seedbox.example.com:7879', token: TOKEN }).warnings().join(' ')).toMatch(/plain http/);
    expect(new AgentClient({ url: 'https://seedbox.example.com', token: TOKEN }).warnings()).toEqual([]);
    expect(new AgentClient({ url: 'http://127.0.0.1:7879', token: TOKEN }).warnings()).toEqual([]);
  });
});

describe('agent core and router hardening', () => {
  it('answers 400 (not 500) for a malformed percent escape', async () => {
    const { core } = await c.agent();
    const out = await handleAgentRequest(core, { method: 'GET', path: '/torrents/%E0%A4%A', query: new URLSearchParams(), headers: {} });
    expect(out.status).toBe(400);
    expect(out.json).toMatchObject({ code: 'bad-request' });
  });

  it('refuses a save path that leaves the downloads root through a symbolic link', async () => {
    const outside = await c.tmp();
    const { core, root } = await c.agent();
    await symlink(outside, join(root, 'escape'), 'junction');
    const p = pack();
    const error = await core.add({ magnet: p.magnet, savePath: join(root, 'escape', 'tv') }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('forbidden');
    const error2 = await core.add({ magnet: p.magnet, savePath: join(root, '..', 'elsewhere') }).catch((e: unknown) => e);
    expect((error2 as AgentError).code).toBe('forbidden');
    await mkdir(join(root, 'inside'), { recursive: true });
    expect((await core.add({ magnet: p.magnet, savePath: join(root, 'inside', 'new') })).duplicate).toBe(false);
  });

  it('keeps the checksum cache bounded', async () => {
    const { session, root } = await c.agent();
    const core = new EngineAgentCore({ session, downloadsRoot: root, kind: 'standalone', checksumCacheSize: 1 });
    const p = pack();
    await writePack(join(root, 'tv'), p);
    await session.addTorrent({ torrent: p.torrent, category: 'tv', savePath: join(root, 'tv') });
    await waitFor(() => session.getTorrent(p.infoHash)?.state === 'seeding');
    await core.checksum(p.infoHash, 0);
    await core.checksum(p.infoHash, 1);
    expect(core.checksumCacheEntries).toBe(1);
  });
});
