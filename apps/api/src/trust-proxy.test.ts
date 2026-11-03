import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';
import { createTestDb } from './db/test-utils.js';

// ARCLIGHT_TRUSTED_PROXIES end to end: which peer's X-Forwarded-For / -Host the app believes
// (the parser itself is covered in modules/auth/hardening-units.test.ts).

describe('trusted proxies in the app', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function ipSeen(trustedProxies: string | undefined, remoteAddress: string) {
    const dir = await mkdtemp(path.join(tmpdir(), 'arclight-trust-proxy-'));
    const config: AppConfig = { configDir: dir, dbPath: ':memory:', logDir: dir, port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null, ...(trustedProxies === undefined ? {} : { trustedProxies }) };
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
    expect((await ipSeen('203.0.113.50', '203.0.113.50')).ip).toBe('198.51.100.9');
    await close?.();
    close = undefined;
    expect((await ipSeen('none', '127.0.0.1')).ip).toBe('127.0.0.1');
  });

  it('trusts a hop count', async () => {
    expect((await ipSeen('1', '203.0.113.50')).ip).toBe('198.51.100.9');
  });
});
