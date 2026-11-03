import { describe, expect, it, vi } from 'vitest';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { parseTrustedProxies } from '../../trust-proxy.js';
import { originOf, parseCorsOrigins } from '../../origin-policy.js';
import { scrubLogChunk } from '../../logging.js';
import { httpsApplicationHost } from '../../security-headers.js';
import { COMMAND_WRITE_ROUTES, apiKeyScopeAllows, mayRunCommands } from './hook.js';
import { LoginLimiter, LoginLimitedError, MAX_LIMITER_ENTRIES } from './login-limiter.js';
import type { RequestAuth } from './service.js';
import { totpCode } from './totp.js';
import { TwoFactorService } from './two-factor.js';

// Unit regressions for the 0.24 security pass (the full-app ones are in security-hardening.test.ts).

const trusts = (raw: string | undefined, address: string, hop = 0): boolean => {
  const { setting } = parseTrustedProxies(raw);
  return typeof setting === 'function' ? setting(address, hop) : setting;
};

describe('ARCLIGHT_TRUSTED_PROXIES (AUTH-01)', () => {
  it('trusts loopback, private and Docker networks by default, never a public address', () => {
    for (const a of ['127.0.0.1', '::1', '10.1.2.3', '172.18.0.2', '192.168.1.1', '::ffff:192.168.1.1', 'fd00::1']) expect(trusts(undefined, a), a).toBe(true);
    for (const a of ['203.0.113.5', '8.8.8.8', '2001:db8::1']) expect(trusts(undefined, a), a).toBe(false);
  });

  it('accepts all / none / a hop count / a CIDR list (with "private"), and reports bad entries', () => {
    expect(parseTrustedProxies('all').setting).toBe(true);
    expect(parseTrustedProxies('none').setting).toBe(false);
    expect(trusts('2', '203.0.113.5', 0)).toBe(true);
    expect(trusts('2', '203.0.113.5', 1)).toBe(true);
    expect(trusts('2', '203.0.113.5', 2)).toBe(false);
    expect(trusts('10.0.0.2', '10.0.0.2')).toBe(true);
    expect(trusts('10.0.0.2', '10.0.0.3')).toBe(false);
    expect(trusts('203.0.113.0/24, private', '203.0.113.9')).toBe(true);
    expect(trusts('203.0.113.0/24, private', '192.168.0.4')).toBe(true);
    expect(parseTrustedProxies('10.0.0.2, not-an-ip').invalid).toEqual(['not-an-ip']);
  });
});

describe('login limiter (AUTH-01 / AUTH-06 / AUTH-07)', () => {
  it('signing in to your own account does not reset the count against another account (AUTH-06)', () => {
    const l = new LoginLimiter({ maxFailures: 3 });
    for (let i = 0; i < 3; i++) l.fail('198.51.100.1', 'victim');
    l.succeed('198.51.100.1', 'attacker');
    expect(() => l.check('198.51.100.1', 'victim')).toThrow(LoginLimitedError);
  });

  it('backs an account off from any address, then lets the owner in after the delay', () => {
    let t = 0;
    const l = new LoginLimiter({ maxFailures: 100, accountMaxFailures: 10, now: () => t });
    for (let i = 0; i < 10; i++) l.fail(`198.51.100.${i}`, 'owner');
    let err: unknown;
    try {
      l.check('192.0.2.200', 'Owner');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LoginLimitedError);
    expect((err as LoginLimitedError).retryAfter).toBe(30);
    t += 30_001;
    expect(() => l.check('192.0.2.200', 'owner')).not.toThrow();
    // Never longer than five minutes, however many tries.
    for (let i = 0; i < 40; i++) l.fail('198.51.100.9', 'owner');
    try {
      l.check('192.0.2.200', 'owner');
    } catch (e) {
      expect((e as LoginLimitedError).retryAfter).toBeLessThanOrEqual(300);
    }
  });

  it('limits one address across accounts (spraying)', () => {
    const l = new LoginLimiter({ maxFailures: 2 });
    for (let i = 0; i < 10; i++) l.fail('198.51.100.1', `user${i}`);
    expect(() => l.check('198.51.100.1', 'fresh-name')).toThrow(LoginLimitedError);
  });

  it('keeps every map bounded under a flood of addresses (AUTH-07)', () => {
    const l = new LoginLimiter({ maxEntries: 100 });
    for (let i = 0; i < 1000; i++) l.fail(`10.0.${Math.floor(i / 250)}.${i % 250}`, `u${i}`);
    const sizes = l.sizes();
    expect(sizes.pairs).toBeLessThanOrEqual(100);
    expect(sizes.addresses).toBeLessThanOrEqual(100);
    expect(sizes.accounts).toBeLessThanOrEqual(100);
    expect(MAX_LIMITER_ENTRIES).toBeGreaterThan(0);
  });
});

describe('recovery codes (AUTH-10)', () => {
  it('a code read by two racing requests is accepted once', async () => {
    const db = await createTestDb();
    const userId = seedAdmin(db);
    const now = () => new Date('2026-01-01T12:00:00Z');
    const tf = new TwoFactorService(db, now);
    const { secret } = tf.beginTotp(userId, 'admin');
    const [code] = tf.enableTotp(userId, totpCode(secret, now()));
    // Both requests read the row before either writes (another process on the same database).
    const internals = tf as unknown as { row: (id: number) => unknown };
    const snapshot = internals.row(userId);
    expect(tf.useRecoveryCode(userId, code!)).toBe(true);
    vi.spyOn(internals, 'row').mockReturnValue(snapshot);
    expect(tf.useRecoveryCode(userId, code!)).toBe(false);
  });
});

describe('CORS origin lists', () => {
  it('normalises origins and drops what is not http(s)', () => {
    expect(originOf('https://Dash.Example.com:443/x')).toBe('https://dash.example.com');
    expect(parseCorsOrigins('https://a.example.com, http://b.example.com:8080 javascript:alert(1)')).toEqual(['https://a.example.com', 'http://b.example.com:8080']);
    expect(httpsApplicationHost('http://media.example.com')).toBeNull();
    expect(httpsApplicationHost('https://Media.example.com/')).toBe('media.example.com');
  });
});

describe('log scrubbing (DATA-14)', () => {
  it('masks query credentials, header fields and key=value pairs, and keeps JSON lines valid', () => {
    const line = JSON.stringify({
      level: 30,
      msg: 'incoming request',
      req: { url: '/api/v1/x?apikey=k123456789&sig=abcdef&u=3', headers: { authorization: 'Basic dXNlcjpwYXNz', 'x-api-key': 'k2' } },
      note: 'token=t-secret-value',
    });
    const out = scrubLogChunk(`${line}\n`);
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out.trim());
    expect(parsed.req.url).toBe('/api/v1/x?apikey=********&sig=********&u=3');
    expect(parsed.req.headers).toEqual({ authorization: '********', 'x-api-key': '********' });
    expect(parsed.note).not.toContain('t-secret-value');
    expect(scrubLogChunk('plain text ?token=abc\n')).toBe('plain text ?token=********\n');
  });
});

describe('command routes for narrow credentials (DATA-13)', () => {
  const app = { user: null, via: 'app', isAdmin: true, appAccess: [] } as unknown as RequestAuth;
  const key = (scope: 'read' | 'requests' | 'admin') => ({ user: null, via: 'userkey', isAdmin: true, appAccess: [], apiKeyScope: scope }) as unknown as RequestAuth;
  it('refuses writes from app tokens and non-admin keys, allows reads', () => {
    for (const route of COMMAND_WRITE_ROUTES) {
      expect(apiKeyScopeAllows(app, 'PUT', route), route).toBe(false);
      expect(apiKeyScopeAllows(app, 'POST', route), route).toBe(false);
      expect(apiKeyScopeAllows(key('requests'), 'PUT', route), route).toBe(false);
      expect(apiKeyScopeAllows(key('admin'), 'PUT', route), route).toBe(true);
    }
    expect(apiKeyScopeAllows(app, 'GET', '/api/v1/settings/vpn')).toBe(true);
    expect(mayRunCommands(app)).toBe(false);
    expect(mayRunCommands(key('admin'))).toBe(true);
    expect(mayRunCommands({ user: null, via: 'session', isAdmin: true, appAccess: [] } as unknown as RequestAuth)).toBe(true);
  });
});
