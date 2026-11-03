import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDeviceCode, AppDeviceCodePollResponse } from '@arclight/shared';
import { AccountStore, memoryVault } from './accounts';
import { ApiError, setFetch } from './api';
import { startDeviceCodeSignIn, verifyLink, type DeviceCodeApi, type DeviceCodeState } from './device-code';
import { memoryStore } from './kv';
import { getSession, setSession } from './session';
import { fakeFetch } from '../test/fetch';

const SERVER = 'http://arclight.example.com:7878';
const device = { deviceName: 'Living room TV', platform: 'android' as const, appVersion: '1.0.0' };
const user = { id: 4, username: 'sam', displayName: 'Sam', role: 'user', permissions: 0, createdAt: '2026-01-01T00:00:00Z', settings: {} };
const approved: AppDeviceCodePollResponse = {
  status: 'approved',
  token: 'alt_tv',
  deviceId: 21,
  user,
  server: { name: 'Arclight', version: '0.22.0' },
} as unknown as AppDeviceCodePollResponse;

let clock = Date.parse('2026-11-02T10:00:00Z');
const now = () => clock;

function code(n: number, over: Partial<AppDeviceCode> = {}): AppDeviceCode {
  return {
    userCode: `ABCD${String(n).padStart(4, '0')}`,
    pollToken: `poll-${n}`,
    expiresAt: new Date(clock + 600_000).toISOString(),
    intervalSec: 5,
    verifyUrl: `${SERVER}/player/link`,
    ...over,
  } as AppDeviceCode;
}

let store: AccountStore;
let vault: ReturnType<typeof memoryVault>;
let states: DeviceCodeState[];

beforeEach(async () => {
  vi.useFakeTimers();
  clock = Date.parse('2026-11-02T10:00:00Z');
  vault = memoryVault();
  store = new AccountStore(memoryStore(), vault);
  await store.load();
  states = [];
});

afterEach(() => {
  vi.useRealTimers();
  setFetch(null);
  setSession(null);
});

/** Advance the fake clock and timers together. */
async function advance(ms: number) {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

function fakeApi(pollAnswers: Array<AppDeviceCodePollResponse | Error>) {
  let n = 0;
  const api = {
    create: vi.fn(async () => code(++n)),
    poll: vi.fn(async () => {
      const next = pollAnswers.shift() ?? ({ status: 'pending' } as AppDeviceCodePollResponse);
      if (next instanceof Error) throw next;
      return next;
    }),
  } satisfies DeviceCodeApi;
  return api;
}

const last = () => states.at(-1)!;

describe('verifyLink', () => {
  it('adds the formatted code to the confirm address', () => {
    expect(verifyLink('http://arclight.example.com/player/link', 'ABCDEFGH')).toBe('http://arclight.example.com/player/link?code=ABCD-EFGH');
    expect(verifyLink('http://arclight.example.com/player/link?x=1', 'ABCDEFGH')).toContain('x=1&code=ABCD-EFGH');
  });
});

describe('device-code sign-in', () => {
  it('shows the code, polls at the interval and signs in when approved', async () => {
    const api = fakeApi([{ status: 'pending' } as AppDeviceCodePollResponse, approved]);
    startDeviceCodeSignIn(store, SERVER, (s) => states.push(s), { api, device, platform: 'android-tv', now });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.create).toHaveBeenCalledWith(SERVER, expect.objectContaining({ platform: 'android-tv', deviceName: 'Living room TV', serverUrl: SERVER }));
    expect(last()).toMatchObject({ status: 'waiting', display: 'ABCD-0001', qrUrl: `${SERVER}/player/link?code=ABCD-0001` });
    await advance(4_999);
    expect(api.poll).not.toHaveBeenCalled();
    await advance(1);
    expect(api.poll).toHaveBeenCalledWith(SERVER, 'poll-1');
    await advance(5_000);
    expect(last().status).toBe('approved');
    const account = store.active()!;
    expect(account).toMatchObject({ serverUrl: SERVER, username: 'sam', deviceId: 21, method: 'device-code' });
    expect(vault.data.get(account.id)).toBe('alt_tv');
    expect(getSession()).toMatchObject({ token: 'alt_tv' });
    // Done: no more polling.
    await advance(30_000);
    expect(api.poll).toHaveBeenCalledTimes(2);
  });

  it('slows down after "too many requests" and keeps going through network trouble', async () => {
    const api = fakeApi([new ApiError(429, 'slow down', '/x'), new ApiError(0, 'offline', '/x'), new ApiError(503, 'busy', '/x'), approved]);
    startDeviceCodeSignIn(store, SERVER, (s) => states.push(s), { api, device, now });
    await vi.advanceTimersByTimeAsync(0);
    await advance(5_000); // 429 → interval 10s
    expect(api.poll).toHaveBeenCalledTimes(1);
    await advance(9_999);
    expect(api.poll).toHaveBeenCalledTimes(1);
    await advance(1); // network error
    await advance(10_000); // 503
    await advance(10_000); // approved
    expect(api.poll).toHaveBeenCalledTimes(4);
    expect(last().status).toBe('approved');
  });

  it('replaces an expired code on its own, then asks after too many', async () => {
    const api = fakeApi([{ status: 'expired' } as AppDeviceCodePollResponse, new ApiError(410, 'gone', '/x'), { status: 'expired' } as AppDeviceCodePollResponse]);
    const flow = startDeviceCodeSignIn(store, SERVER, (s) => states.push(s), { api, device, now, maxRenewals: 2 });
    await vi.advanceTimersByTimeAsync(0);
    await advance(5_000); // expired → code 2
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(last()).toMatchObject({ status: 'waiting', display: 'ABCD-0002' });
    await advance(5_000); // 410 → code 3
    expect(api.create).toHaveBeenCalledTimes(3);
    await advance(5_000); // expired, no renewals left
    expect(last().status).toBe('expired');
    flow.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.create).toHaveBeenCalledTimes(4);
    expect(last()).toMatchObject({ status: 'waiting', display: 'ABCD-0004' });
  });

  it('treats a code past its expiry time as expired without asking the server', async () => {
    let n = 0;
    const api = {
      create: vi.fn(async () => code(++n, { expiresAt: new Date(clock + 8_000).toISOString() })),
      poll: vi.fn(async () => ({ status: 'pending' }) as AppDeviceCodePollResponse),
    };
    startDeviceCodeSignIn(store, SERVER, (s) => states.push(s), { api, device, now, maxRenewals: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await advance(5_000);
    expect(api.poll).toHaveBeenCalledTimes(1);
    await advance(5_000);
    expect(api.poll).toHaveBeenCalledTimes(1);
    expect(last().status).toBe('expired');
  });

  it('stops on a refusal (player turned off for this user)', async () => {
    const api = fakeApi([new ApiError(403, 'nope', '/app/device-codes/poll', 'PLAYER_NOT_ALLOWED')]);
    startDeviceCodeSignIn(store, SERVER, (s) => states.push(s), { api, device, now });
    await vi.advanceTimersByTimeAsync(0);
    await advance(5_000);
    expect(last().status).toBe('error');
    await advance(30_000);
    expect(api.poll).toHaveBeenCalledTimes(1);
  });

  it('reports a server that cannot be reached when asking for a code', async () => {
    const api = { create: vi.fn(async () => Promise.reject(new ApiError(0, 'offline', '/x'))), poll: vi.fn() };
    startDeviceCodeSignIn(store, SERVER, (s) => states.push(s), { api, device, now });
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ status: 'error', reason: 'network' });
  });

  it('cancel stops polling', async () => {
    const api = fakeApi([]);
    const flow = startDeviceCodeSignIn(store, SERVER, (s) => states.push(s), { api, device, now });
    await vi.advanceTimersByTimeAsync(0);
    flow.cancel();
    await advance(60_000);
    expect(api.poll).not.toHaveBeenCalled();
  });

  it('talks to the real endpoints by default', async () => {
    const { impl, calls } = fakeFetch({
      'POST /app/device-codes': { json: code(1) },
      'POST /app/device-codes/poll': { json: approved },
    });
    setFetch(impl);
    startDeviceCodeSignIn(store, SERVER, (s) => states.push(s), { device, now });
    await vi.advanceTimersByTimeAsync(0);
    await advance(5_000);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['POST /api/v1/app/device-codes', 'POST /api/v1/app/device-codes/poll']);
    expect(calls[1]!.body).toEqual({ pollToken: 'poll-1' });
    expect(calls[0]!.headers.get('authorization')).toBeNull();
    expect(last().status).toBe('approved');
  });
});
