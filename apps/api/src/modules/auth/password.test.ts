import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword } from './password.js';
import { allLocal, isLocalAddress } from './network.js';
import { readCookie, sessionCookie } from './cookies.js';
import { isPublicRoute } from './hook.js';
import { hasPermission, Permission } from '@arclight/shared';

describe('password hashing', () => {
  it('produces a self-describing scrypt hash with a random salt', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('s3cret-pass');
    expect(await verifyPassword('s3cret-pass', hash)).toBe(true);
    expect(await verifyPassword('s3cret-Pass', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('never verifies against malformed hashes', async () => {
    for (const bad of ['', 'plain', 'scrypt$x$8$1$abc$def', 'bcrypt$1$2$3$4$5', 'scrypt$16384$8$1$$']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('honours the cost stored in the hash and flags weak ones for rehash', async () => {
    const weak = await hashPassword('pw-weak-cost', { N: 1024, r: 8, p: 1 });
    expect(await verifyPassword('pw-weak-cost', weak)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(await hashPassword('pw'))).toBe(false);
  });

  it('normalises unicode before hashing', async () => {
    const hash = await hashPassword('café');
    expect(await verifyPassword('café', hash)).toBe(true);
  });
});

describe('local address rules', () => {
  it('accepts loopback, RFC 1918, link-local and IPv6 private ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.1.1', '::1', 'fd12::1', 'fe80::1%eth0', '::ffff:192.168.0.5']) {
      expect(isLocalAddress(ip), ip).toBe(true);
    }
  });

  it('rejects public and malformed addresses', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.64.0.1', '2001:db8::1', '::ffff:8.8.8.8', 'localhost', '', '999.1.1.1']) {
      expect(isLocalAddress(ip), ip).toBe(false);
    }
  });

  it('requires every hop of a forwarded chain to be local', () => {
    expect(allLocal(['192.168.1.2', '10.0.0.1'])).toBe(true);
    expect(allLocal(['8.8.8.8', '192.168.1.2'])).toBe(false);
    expect(allLocal([undefined])).toBe(false);
  });
});

describe('cookies, public routes and permissions', () => {
  it('builds an httpOnly lax cookie, secure only on https', () => {
    expect(sessionCookie('abc', { maxAgeSeconds: 60, secure: false })).toBe('al_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=60');
    expect(sessionCookie('abc', { maxAgeSeconds: null, secure: true })).toBe('al_session=abc; Path=/; HttpOnly; SameSite=Lax; Secure');
    expect(readCookie('a=1; al_session=tok%3D; b=2', 'al_session')).toBe('tok=');
    expect(readCookie('a=1', 'al_session')).toBeUndefined();
  });

  it('classifies public routes by matched pattern', () => {
    expect(isPublicRoute('/api/v1/auth/login')).toBe(true);
    expect(isPublicRoute('/api/v1/setup/complete')).toBe(true);
    expect(isPublicRoute('/api/v1/calendar/feed.ics')).toBe(true);
    expect(isPublicRoute('/api/v1/auth/me')).toBe(false);
    expect(isPublicRoute('/api/v1/user')).toBe(false);
    expect(isPublicRoute(undefined)).toBe(false);
  });

  it('treats ADMIN as implying every permission', () => {
    expect(hasPermission(Permission.ADMIN, Permission.MANAGE_USERS)).toBe(true);
    expect(hasPermission(Permission.REQUEST, Permission.MANAGE_USERS)).toBe(false);
    expect(hasPermission(0, 0)).toBe(true);
  });
});
