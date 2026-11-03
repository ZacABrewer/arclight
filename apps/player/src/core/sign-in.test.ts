import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore, memoryVault } from './accounts';
import { resetArtworkLink, setFetch } from './api';
import { memoryStore } from './kv';
import { getSession, setSession } from './session';
import { signInWithPairCode, signInWithPassword, signOut } from './sign-in';
import { fakeFetch } from '../test/fetch';

const SERVER = 'http://192.168.1.20:7878';
const device = { deviceName: 'Test phone', platform: 'android' as const, appVersion: '1.0.0' };
const user = { id: 4, username: 'sam', displayName: 'Sam', role: 'user', permissions: 0, createdAt: '2026-01-01T00:00:00Z', settings: {} };
const ok = { json: { token: 'alt_abc', deviceId: 11, user, server: { name: 'Arclight', version: '0.22.0' } } };

let store: AccountStore;
let vault: ReturnType<typeof memoryVault>;

beforeEach(async () => {
  resetArtworkLink();
  vault = memoryVault();
  store = new AccountStore(memoryStore(), vault);
  await store.load();
});

afterEach(() => {
  setFetch(null);
  setSession(null);
});

describe('password sign-in', () => {
  it('signs in, stores the token in the vault and activates the account', async () => {
    const { impl, calls } = fakeFetch({ 'POST /app/sign-in': ok });
    setFetch(impl);
    const out = await signInWithPassword(store, { serverUrl: SERVER, username: 'sam', password: 'pw' }, device);
    expect(out.ok).toBe(true);
    expect(calls[0]!.body).toEqual({ username: 'sam', password: 'pw', ...device });
    expect(calls[0]!.headers.get('authorization')).toBeNull();
    const account = store.active()!;
    expect(account).toMatchObject({ serverUrl: SERVER, username: 'sam', displayName: 'Sam', deviceId: 11, method: 'password' });
    expect(vault.data.get(account.id)).toBe('alt_abc');
    expect(getSession()).toMatchObject({ accountId: account.id, serverUrl: SERVER, token: 'alt_abc' });
  });

  it('asks for the authenticator code, then sends it', async () => {
    const { impl, calls } = fakeFetch({
      'POST /app/sign-in': (c) => ((c.body as { totp?: string }).totp === '123456' ? ok : { status: 401, json: { error: 'Code needed', code: 'TOTP_REQUIRED' } }),
    });
    setFetch(impl);
    const first = await signInWithPassword(store, { serverUrl: SERVER, username: 'sam', password: 'pw' }, device);
    expect(first).toMatchObject({ ok: false, reason: 'totp-required' });
    const second = await signInWithPassword(store, { serverUrl: SERVER, username: 'sam', password: 'pw', totp: '123456' }, device);
    expect(second.ok).toBe(true);
    expect((calls[1]!.body as { totp: string }).totp).toBe('123456');
  });

  it.each([
    [401, 'TOTP_INVALID', 'totp-invalid'],
    [401, 'INVALID_CREDENTIALS', 'credentials'],
    [403, 'PAIRING_REQUIRED', 'pairing-required'],
    [403, 'TWO_FACTOR_SETUP_REQUIRED', 'two-factor-setup'],
    [403, 'PLAYER_DISABLED', 'player-disabled'],
    [403, 'PLAYER_NOT_ALLOWED', 'player-not-allowed'],
    [429, 'RATE_LIMITED', 'rate-limited'],
  ])('maps %i %s', async (status, code, reason) => {
    setFetch(fakeFetch({ 'POST /app/sign-in': { status, json: { error: 'x', code } } }).impl);
    const out = await signInWithPassword(store, { serverUrl: SERVER, username: 'sam', password: 'pw' }, device);
    expect(out).toMatchObject({ ok: false, reason });
    expect(store.list()).toHaveLength(0);
  });
});

describe('pairing', () => {
  it('pairs with a code typed with a dash', async () => {
    const { impl, calls } = fakeFetch({ 'POST /app/pair': ok });
    setFetch(impl);
    const out = await signInWithPairCode(store, SERVER, 'abcd-efgh', device);
    expect(out.ok).toBe(true);
    expect(calls[0]!.body).toEqual({ code: 'ABCDEFGH', ...device });
    expect(store.active()?.method).toBe('pairing');
  });

  it('rejects a malformed code without asking the server', async () => {
    const { impl, calls } = fakeFetch({ 'POST /app/pair': ok });
    setFetch(impl);
    const out = await signInWithPairCode(store, SERVER, 'ABC0', device);
    expect(out).toMatchObject({ ok: false, reason: 'pair-invalid' });
    expect(calls).toHaveLength(0);
  });

  it('reports an expired code', async () => {
    setFetch(fakeFetch({ 'POST /app/pair': { status: 410, json: { error: 'expired', code: 'PAIR_CODE_EXPIRED' } } }).impl);
    expect(await signInWithPairCode(store, SERVER, 'ABCDEFGH', device)).toMatchObject({ ok: false, reason: 'pair-expired' });
  });
});

describe('accounts', () => {
  it('keeps several accounts and signs one out', async () => {
    const { impl, calls } = fakeFetch({
      'POST /app/sign-in': (c) => ({ json: { ...ok.json, token: `alt_${(c.body as { username: string }).username}`, user: { ...user, id: (c.body as { username: string }).username === 'sam' ? 4 : 5, username: (c.body as { username: string }).username } } }),
      'POST /app/sign-out': { status: 204 },
    });
    setFetch(impl);
    await signInWithPassword(store, { serverUrl: SERVER, username: 'sam', password: 'pw' }, device);
    await signInWithPassword(store, { serverUrl: SERVER, username: 'kim', password: 'pw' }, device);
    // Signing in again as the same user replaces the entry.
    await signInWithPassword(store, { serverUrl: SERVER, username: 'kim', password: 'pw' }, device);
    expect(store.list().map((a) => a.username)).toEqual(['sam', 'kim']);
    const kim = store.active()!;
    await signOut(store, kim.id);
    const signOutCall = calls.find((c) => c.url.endsWith('/app/sign-out'))!;
    expect(signOutCall.headers.get('authorization')).toBe('Bearer alt_kim');
    expect(store.list().map((a) => a.username)).toEqual(['sam']);
    expect(vault.data.has(kim.id)).toBe(false);
    expect(getSession()?.token).toBe('alt_sam');
  });

  it('an expired token keeps the account but ends the session', async () => {
    setFetch(fakeFetch({ 'POST /app/sign-in': ok }).impl);
    await signInWithPassword(store, { serverUrl: SERVER, username: 'sam', password: 'pw' }, device);
    const id = store.active()!.id;
    await store.expire(id);
    expect(store.list()).toHaveLength(1);
    expect(await store.activate()).toBeNull();
  });
});
