import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './accounts';
import { setFetch, setUnauthorizedHandler } from './api';
import { pickAddress, reachesAccount, routeAccount } from './server-route';

const LAN = 'http://192.168.1.20:7878';
const WAN = 'https://music.example.com';

const account = (over: { [K in keyof Account]?: Account[K] | undefined } = {}): Account => ({
  id: 'a_1',
  serverUrl: WAN,
  addresses: [LAN, WAN],
  serverName: 'Arclight',
  serverVersion: '0.28.0',
  userId: 1,
  username: 'user1',
  displayName: null,
  deviceId: 1,
  method: 'password',
  addedAt: '2026-11-04T00:00:00Z',
  ...(over as Partial<Account>),
});

/** Answers per address after `ms`: true (this account's server) or false. */
const answers = (map: Record<string, [ok: boolean, ms: number]>) =>
  vi.fn((url: string) => new Promise<boolean>((r) => setTimeout(() => r(map[url]?.[0] ?? false), map[url]?.[1] ?? 0)));

describe('pickAddress', () => {
  it('uses the first address when it answers, even after the second', async () => {
    expect(await pickAddress([LAN, WAN], answers({ [LAN]: [true, 20], [WAN]: [true, 0] }))).toBe(LAN);
  });

  it('falls back to the second when the first does not answer', async () => {
    const check = answers({ [LAN]: [false, 0], [WAN]: [true, 0] });
    expect(await pickAddress([LAN, WAN], check)).toBe(WAN);
    // Both are asked at once.
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('treats a check that throws as no answer, and none answering as null', async () => {
    expect(await pickAddress([LAN, WAN], async () => Promise.reject(new Error('boom')))).toBeNull();
  });
});

describe('routeAccount', () => {
  it('moves to the first address when it answers again', async () => {
    expect(await routeAccount(account(), answers({ [LAN]: [true, 0], [WAN]: [true, 0] }))).toBe(LAN);
  });

  it('keeps the address in use when it is already the right one, or nothing answers', async () => {
    expect(await routeAccount(account({ serverUrl: LAN }), answers({ [LAN]: [true, 0] }))).toBeNull();
    expect(await routeAccount(account(), answers({}))).toBeNull();
  });

  it('does nothing for an account with one address', async () => {
    const check = vi.fn(async () => true);
    expect(await routeAccount(account({ addresses: undefined }), check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });
});

describe('reachesAccount', () => {
  const user = (id: number) => ({ id, username: 'sam', displayName: 'Sam', role: 'user', permissions: 0, createdAt: '2026-01-01T00:00:00Z', settings: {} });
  afterEach(() => {
    setFetch(null);
    setUnauthorizedHandler(null);
  });

  it('needs the same user on that address, and a refused token there signs nobody out', async () => {
    const seen: string[] = [];
    const answer = (status: number, body: unknown) =>
      setFetch(async (input, init) => {
        seen.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`);
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      });
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const check = reachesAccount({ userId: 1 }, 'alt_1');

    answer(200, user(1));
    expect(await check(WAN, 1_000)).toBe(true);
    expect(seen[0]).toBe(`${WAN}/api/v1/user/me Bearer alt_1`);
    answer(200, user(2));
    expect(await check(WAN, 1_000)).toBe(false);
    answer(401, { error: 'Unauthorized' });
    expect(await check(WAN, 1_000)).toBe(false);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
