import { Capacitor } from '@capacitor/core';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import type { User } from '@arclight/shared';
import { preferencesStore, readJson, writeJson, type KeyValueStore } from './kv';
import { setSession, type Session } from './session';

// The servers and accounts this install is signed in to. Several are allowed (home server,
// a friend's server, two users on one server); one is active. The list (no secrets) lives in
// Preferences; each device token lives in the platform's secure store (Keychain / Android
// Keystore-backed storage via @capgo/capacitor-native-biometric), never in Preferences.

export interface Account {
  /** Local id ("a_<random>"). */
  id: string;
  serverUrl: string;
  /** Server name from sign-in ("Arclight" unless the admin renamed it). */
  serverName: string;
  serverVersion: string;
  userId: number;
  username: string;
  displayName: string | null;
  /** Server-side device id (Settings → Devices on the server lists it). */
  deviceId: number | null;
  method: 'password' | 'pairing';
  addedAt: string;
}

interface StoredAccounts {
  version: 1;
  accounts: Account[];
  activeId: string | null;
}

const KEY = 'arclight.accounts';

/** Where tokens are kept. */
export interface TokenVault {
  get(accountId: string): Promise<string | null>;
  set(accountId: string, token: string): Promise<void>;
  remove(accountId: string): Promise<void>;
}

const vaultServer = (accountId: string) => `com.moviemethat.arclight.account.${accountId}`;

/** The secure store on a device. The library's browser build keeps values in memory only. */
export const secureVault: TokenVault = {
  async get(accountId) {
    try {
      const c = await NativeBiometric.getCredentials({ server: vaultServer(accountId) });
      return c.password || null;
    } catch {
      return null;
    }
  },
  set: (accountId, token) => NativeBiometric.setCredentials({ server: vaultServer(accountId), username: accountId, password: token }),
  async remove(accountId) {
    try {
      await NativeBiometric.deleteCredentials({ server: vaultServer(accountId) });
    } catch {
      /* already gone */
    }
  },
};

export function memoryVault(): TokenVault & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (id) => data.get(id) ?? null,
    set: async (id, token) => void data.set(id, token),
    remove: async (id) => void data.delete(id),
  };
}

/**
 * In a desktop browser (`pnpm dev`) the secure store forgets everything on reload; keep tokens
 * in sessionStorage there so a reload stays signed in. Never used on a device.
 */
function devVault(): TokenVault {
  const k = (id: string) => `arclight.dev-token.${id}`;
  return {
    get: async (id) => sessionStorage.getItem(k(id)),
    set: async (id, t) => sessionStorage.setItem(k(id), t),
    remove: async (id) => sessionStorage.removeItem(k(id)),
  };
}

export function defaultVault(): TokenVault {
  return Capacitor.isNativePlatform() ? secureVault : devVault();
}

function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `a_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface SignedIn {
  serverUrl: string;
  token: string;
  deviceId: number;
  user: Pick<User, 'id' | 'username'> & { displayName?: string | null | undefined };
  server: { name: string; version: string };
  method: 'password' | 'pairing';
}

type Listener = (state: { accounts: Account[]; active: Account | null }) => void;

export class AccountStore {
  private accounts: Account[] = [];
  private activeId: string | null = null;
  private loaded = false;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly kv: KeyValueStore = preferencesStore,
    private readonly vault: TokenVault = defaultVault(),
  ) {}

  async load(): Promise<void> {
    const stored = await readJson<StoredAccounts>(this.kv, KEY);
    this.accounts = Array.isArray(stored?.accounts) ? stored.accounts : [];
    this.activeId = stored?.activeId && this.accounts.some((a) => a.id === stored.activeId) ? stored.activeId : (this.accounts[0]?.id ?? null);
    this.loaded = true;
  }

  list(): Account[] {
    return [...this.accounts];
  }

  active(): Account | null {
    return this.accounts.find((a) => a.id === this.activeId) ?? null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async save(): Promise<void> {
    await writeJson(this.kv, KEY, { version: 1, accounts: this.accounts, activeId: this.activeId } satisfies StoredAccounts);
    const state = { accounts: this.list(), active: this.active() };
    for (const l of [...this.listeners]) l(state);
  }

  private ensureLoaded(): void {
    if (!this.loaded) throw new Error('AccountStore.load() first');
  }

  /**
   * Remembers a fresh sign-in and makes it active. Signing in again as the same user on the same
   * server replaces that account (and its old token) instead of adding a second entry.
   */
  async add(signed: SignedIn): Promise<Account> {
    this.ensureLoaded();
    const existing = this.accounts.find((a) => a.serverUrl === signed.serverUrl && a.userId === signed.user.id);
    const account: Account = {
      id: existing?.id ?? newId(),
      serverUrl: signed.serverUrl,
      serverName: signed.server.name,
      serverVersion: signed.server.version,
      userId: signed.user.id,
      username: signed.user.username,
      displayName: signed.user.displayName ?? null,
      deviceId: signed.deviceId,
      method: signed.method,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    };
    await this.vault.set(account.id, signed.token);
    this.accounts = existing ? this.accounts.map((a) => (a.id === account.id ? account : a)) : [...this.accounts, account];
    this.activeId = account.id;
    await this.save();
    return account;
  }

  async token(accountId: string): Promise<string | null> {
    return this.vault.get(accountId);
  }

  async setActive(accountId: string): Promise<void> {
    this.ensureLoaded();
    if (!this.accounts.some((a) => a.id === accountId)) throw new Error(`Unknown account ${accountId}`);
    this.activeId = accountId;
    await this.save();
  }

  /** Forgets an account and its token (the caller signs it out on the server first, when online). */
  async remove(accountId: string): Promise<void> {
    this.ensureLoaded();
    await this.vault.remove(accountId);
    this.accounts = this.accounts.filter((a) => a.id !== accountId);
    if (this.activeId === accountId) this.activeId = this.accounts[0]?.id ?? null;
    await this.save();
  }

  /** Drops an account's token (refused by the server) but keeps the account to sign in again. */
  async expire(accountId: string): Promise<void> {
    await this.vault.remove(accountId);
    await this.save();
  }

  /** The active account as a request session, or null (no account, or its token is gone). */
  async session(): Promise<Session | null> {
    const a = this.active();
    if (!a) return null;
    const token = await this.vault.get(a.id);
    if (!token) return null;
    return { accountId: a.id, serverUrl: a.serverUrl, token, deviceId: a.deviceId };
  }

  /** Points the API client at the active account. */
  async activate(): Promise<Session | null> {
    const s = await this.session();
    setSession(s);
    return s;
  }
}

export function accountLabel(a: Account): string {
  return a.displayName || a.username;
}
