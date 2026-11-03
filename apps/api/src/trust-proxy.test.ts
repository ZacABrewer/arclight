import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';
import { createTestDb } from './db/test-utils.js';
import { DEFAULT_TRUST_PROXY, parseTrustProxy } from './trust-proxy.js';

describe('parseTrustProxy', () => {
  it('defaults to loopback, private, link-local and CGNAT ranges', () => {
    expect(parseTrustProxy(undefined)).toBe(DEFAULT_TRUST_PROXY);
    expect(parseTrustProxy('  ')).toBe(DEFAULT_TRUST_PROXY);
  });

  it('reads booleans and hop counts', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('TRUE')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    const one = parseTrustProxy('1') as (address: string, hop: number) => boolean;
    expect([one('10.0.0.1', 0), one('10.0.0.1', 1)]).toEqual([true, false]);
    const none = parseTrustProxy('0') as (address: string, hop: number) => boolean;
    expect(none('10.0.0.1', 0)).toBe(false);
  });

  it('accepts IPs, CIDRs, netmasks and range names', () => {
    expect(parseTrustProxy('203.0.113.7')).toBe('203.0.113.7');
    expect(parseTrustProxy(' Loopback , 10.0.0.0/8,fd00::/8, 192.168.0.0/255.255.0.0 ,::1 ')).toBe(
      'loopback,10.0.0.0/8,fd00::/8,192.168.0.0/255.255.0.0,::1',
    );
  });

  it('rejects anything Fastify would misread', () => {
    for (const bad of ['yes', 'example.com', '10.0.0.0/33', 'fd00::/129', '10.0.0/8', '::1/255.0.0.0', ',', '1.2.3.4,nope']) {
      expect(() => parseTrustProxy(bad), bad).toThrow(/ARCLIGHT_TRUST_PROXY/);
    }
  });
});

describe('trustProxy in the app', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function ipSeen(trustProxy: AppConfig['trustProxy'] | undefined, remoteAddress: string) {
    const dir = await mkdtemp(path.join(tmpdir(), 'arclight-trust-proxy-'));
    const config: AppConfig = { configDir: dir, dbPath: ':memory:', logDir: dir, port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null, ...(trustProxy === undefined ? {} : { trustProxy }) };
    const app = await buildApp(config, await createTestDb(), pino({ level: 'silent' }), { probe: false });
    app.get('/__ip', async (req) => ({ ip: req.ip, host: req.host }));
    await app.ready();
    close = async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    };
    const res = await app.inject({ method: 'GET', url: '/__ip', remoteAddress, headers: { 'x-forwarded-for': '198.51.100.9', 'x-forwarded-host': 'spoofed.example.com', host: 'arclight.example.com' } });
    return res.json() as { ip: string; host: string };
  }

  it('honours forwarded headers from a private-range proxy by default', async () => {
    expect(await ipSeen(undefined, '172.30.53.2')).toEqual({ ip: '198.51.100.9', host: 'spoofed.example.com' });
  });

  it('ignores forwarded headers from a public peer by default', async () => {
    expect(await ipSeen(undefined, '203.0.113.50')).toEqual({ ip: '203.0.113.50', host: 'arclight.example.com' });
  });

  it('can trust a listed public proxy, or nobody', async () => {
    expect((await ipSeen(parseTrustProxy('203.0.113.50'), '203.0.113.50')).ip).toBe('198.51.100.9');
    await close?.();
    close = undefined;
    expect((await ipSeen(false, '127.0.0.1')).ip).toBe('127.0.0.1');
  });

  it('trusts a hop count', async () => {
    expect((await ipSeen(parseTrustProxy('1'), '203.0.113.50')).ip).toBe('198.51.100.9');
  });
});
