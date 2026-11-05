import { describe, expect, it, vi } from 'vitest';
import { AccountStore, memoryVault, migratingVault, type TokenVault } from './accounts';
import { memoryStore } from './kv';

const unimplemented = () => Object.assign(new Error('not in this build'), { code: 'UNIMPLEMENTED' });

function missingVault(): TokenVault {
  return {
    get: vi.fn(async () => Promise.reject(unimplemented())),
    set: vi.fn(async () => Promise.reject(unimplemented())),
    remove: vi.fn(async () => Promise.reject(unimplemented())),
  };
}

describe('migratingVault', () => {
  it('moves a token saved by an earlier version to the new store on first read', async () => {
    const next = memoryVault();
    const legacy = memoryVault();
    legacy.data.set('a_1', 'alt_old');
    const vault = migratingVault(next, legacy);
    expect(await vault.get('a_1')).toBe('alt_old');
    expect(next.data.get('a_1')).toBe('alt_old');
    expect(legacy.data.has('a_1')).toBe(false);
    expect(await vault.get('a_1')).toBe('alt_old');
  });

  it('keeps the old copy when the move fails, so nobody is signed out', async () => {
    const next = memoryVault();
    next.set = async () => Promise.reject(new Error('keychain busy'));
    const legacy = memoryVault();
    legacy.data.set('a_1', 'alt_old');
    const vault = migratingVault(next, legacy);
    expect(await vault.get('a_1')).toBe('alt_old');
    expect(legacy.data.get('a_1')).toBe('alt_old');
  });

  it('writes new tokens to the new store only, and removes from both', async () => {
    const next = memoryVault();
    const legacy = memoryVault();
    legacy.data.set('a_1', 'alt_old');
    const vault = migratingVault(next, legacy);
    await vault.set('a_1', 'alt_new');
    expect(next.data.get('a_1')).toBe('alt_new');
    expect(legacy.data.has('a_1')).toBe(false);
    legacy.data.set('a_1', 'alt_stale');
    await vault.remove('a_1');
    expect(next.data.size + legacy.data.size).toBe(0);
    expect(await vault.get('a_1')).toBeNull();
  });

  it('falls back to the old store when the new one is not in this build', async () => {
    const next = missingVault();
    const legacy = memoryVault();
    legacy.data.set('a_1', 'alt_old');
    const vault = migratingVault(next, legacy);
    expect(await vault.get('a_1')).toBe('alt_old');
    expect(legacy.data.get('a_1')).toBe('alt_old');
    await vault.set('a_2', 'alt_two');
    expect(legacy.data.get('a_2')).toBe('alt_two');
    await vault.remove('a_1');
    expect(legacy.data.has('a_1')).toBe(false);
  });

  it('passes other errors on', async () => {
    const next = memoryVault();
    next.get = async () => Promise.reject(new Error('Keychain read failed (-25308)'));
    await expect(migratingVault(next, memoryVault()).get('a_1')).rejects.toThrow('-25308');
  });
});

describe('AccountStore.moveServer', () => {
  it('moves every account on a server to its new address', async () => {
    const kv = memoryStore();
    const store = new AccountStore(kv, memoryVault());
    await store.load();
    const signed = (serverUrl: string, id: number) => ({
      serverUrl,
      token: `alt_${id}`,
      deviceId: id,
      user: { id, username: `user${id}` },
      server: { name: 'Arclight', version: '0.24.0' },
      method: 'password' as const,
    });
    const a = await store.add(signed('http://music.example.com:7878', 1));
    const b = await store.add(signed('http://192.168.1.20:7878', 2));
    await store.moveServer('http://music.example.com:7878', 'https://music.example.com');
    const byId = new Map(store.list().map((x) => [x.id, x.serverUrl]));
    expect(byId.get(a.id)).toBe('https://music.example.com');
    expect(byId.get(b.id)).toBe('http://192.168.1.20:7878');

    const reloaded = new AccountStore(kv, memoryVault());
    await reloaded.load();
    expect(reloaded.list().find((x) => x.id === a.id)?.serverUrl).toBe('https://music.example.com');
  });
});

describe('AccountStore addresses', () => {
  const LAN = 'http://192.168.1.20:7878';
  const WAN = 'https://music.example.com';
  const signed = (serverUrl: string) => ({
    serverUrl,
    token: 'alt_1',
    deviceId: 1,
    user: { id: 1, username: 'user1' },
    server: { name: 'Arclight', version: '0.28.0' },
    method: 'password' as const,
  });

  it('keeps two addresses in order, uses either, and goes back to one', async () => {
    const kv = memoryStore();
    const store = new AccountStore(kv, memoryVault());
    await store.load();
    const a = await store.add(signed(WAN));
    await store.setAddresses(a.id, [LAN, WAN]);
    expect(store.active()).toMatchObject({ serverUrl: WAN, addresses: [LAN, WAN] });
    await store.setServerUrl(a.id, LAN);
    expect(store.active()?.serverUrl).toBe(LAN);
    await store.setServerUrl(a.id, 'https://elsewhere.example.com');
    expect(store.active()?.serverUrl).toBe(LAN);

    const reloaded = new AccountStore(kv, memoryVault());
    await reloaded.load();
    expect(reloaded.active()).toMatchObject({ serverUrl: LAN, addresses: [LAN, WAN] });

    // Removing the address in use moves to the one left.
    await store.setAddresses(a.id, [WAN]);
    expect(store.active()?.serverUrl).toBe(WAN);
    expect(store.active()?.addresses).toBeUndefined();
  });

  it('signing in again on the second address updates the same account', async () => {
    const store = new AccountStore(memoryStore(), memoryVault());
    await store.load();
    const a = await store.add(signed(WAN));
    await store.setAddresses(a.id, [LAN, WAN]);
    const again = await store.add(signed(LAN));
    expect(again.id).toBe(a.id);
    expect(store.list()).toHaveLength(1);
    expect(store.active()).toMatchObject({ serverUrl: LAN, addresses: [LAN, WAN] });
  });

  it('a server move updates the address list too', async () => {
    const store = new AccountStore(memoryStore(), memoryVault());
    await store.load();
    const a = await store.add(signed('http://music.example.com:7878'));
    await store.setAddresses(a.id, [LAN, 'http://music.example.com:7878']);
    await store.setServerUrl(a.id, 'http://music.example.com:7878');
    await store.moveServer('http://music.example.com:7878', WAN);
    expect(store.active()).toMatchObject({ serverUrl: WAN, addresses: [LAN, WAN] });
  });
});
