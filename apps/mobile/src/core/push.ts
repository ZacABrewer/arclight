import { KEYS } from '../config.js';
import type { HttpClient } from './http.js';
import { readJson, type KeyValueStore } from './kv.js';

// Push registration with the Arclight push relay.
//
//   POST   {relay}/v1/devices            { token, platform, appId, appVersion, environment? } -> { deviceId, secret }
//          appId: this app's bundle ID; the relay uses it as the APNs topic.
//          environment (iOS only): 'sandbox' for development-signed builds, 'production' otherwise.
//   PUT    {relay}/v1/devices/{id}       { token }   Authorization: Bearer {secret}  (token rotated)
//   DELETE {relay}/v1/devices/{id}                   Authorization: Bearer {secret}
//
// One relay device per saved server (per server origin): each server that calls registerPush
// gets its own { relayDeviceId, relaySecret }, so a server can only send to, re-point or delete
// its own registration, never another server's. The credentials live in the native secure store
// (Keychain / Android Keystore), scoped by server origin; a server page can only reach its own
// scope (the native layer picks the scope from the calling page, whatever the page asks for).
//
// Before 0.24 the app had one relay device shared by every server, stored in Preferences
// (KEYS.push). migrateLegacy() moves it into the secure store as a "shared" registration for each
// server that used it, so existing servers keep sending. A server that turns notifications on
// again gets a device of its own; the shared device is deleted at the relay once no saved server
// uses it any more (reconcile()).

export type Platform = 'ios' | 'android';
export type PushErrorCode = 'denied' | 'unavailable' | 'relay';

export class PushError extends Error {
  constructor(
    readonly code: PushErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PushError';
  }
}

/**
 * Secret storage scoped by server origin (native: Keychain / Keystore-encrypted). Scope '' is the
 * app's own; the native layer forces a server page's calls into that page's origin.
 */
export interface ScopedStore {
  get(scope: string, key: string): Promise<string | null>;
  set(scope: string, key: string, value: string): Promise<void>;
  remove(scope: string, key: string): Promise<void>;
}

export function memoryScopedStore(): ScopedStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const k = (scope: string, key: string) => `${scope}\n${key}`;
  return {
    data,
    get: async (s, key) => data.get(k(s, key)) ?? null,
    set: async (s, key, v) => void data.set(k(s, key), v),
    remove: async (s, key) => void data.delete(k(s, key)),
  };
}

/** The registration of one server origin. */
export interface PushState {
  deviceId: string;
  secret: string;
  token: string;
  /** The pre-0.24 device shared with other servers (never deleted from a single server's scope). */
  shared?: true;
}

/** Pre-0.24 Preferences shape. */
interface LegacyState {
  deviceId: string;
  secret: string;
  token: string;
  servers: string[];
}

const STATE_KEY = 'push';
const LEGACY_KEY = 'legacyPush';

export interface PushDeps {
  store: ScopedStore;
  http: HttpClient;
  relayUrl: string;
  platform: Platform;
  /** Bundle ID / application ID (config APP_ID). */
  appId: string;
  appVersion: string;
  /** Whether the build can receive push at all (Android: google-services.json was present). */
  pushAvailable: () => Promise<boolean>;
  /** Asks for notification permission if needed; resolves to whether it is granted. */
  requestPermission: () => Promise<boolean>;
  /** Registers with APNs/FCM and resolves to the device token. */
  getToken: () => Promise<string>;
  deviceName: () => Promise<string>;
  /** APNs environment of this build (iOS); ignored on Android. */
  environment: () => Promise<'production' | 'sandbox'>;
}

export interface PushRegistration {
  relayDeviceId: string;
  relaySecret: string;
  platform: Platform;
  deviceName: string;
  /** Bundle ID of the app that registered; the server stores it and sends it to the relay. */
  appId: string;
}

const RELAY_TIMEOUT_MS = 15000;

function asObject(data: unknown): Record<string, unknown> | null {
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

function isState(v: unknown): v is PushState {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o.deviceId === 'string' && typeof o.secret === 'string' && typeof o.token === 'string';
}

export class PushService {
  constructor(private readonly d: PushDeps) {}

  private relay(path: string): string {
    return `${this.d.relayUrl.replace(/\/+$/, '')}${path}`;
  }

  private async read(scope: string, key: string): Promise<PushState | null> {
    const raw = await this.d.store.get(scope, key);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as unknown;
      return isState(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** The registration of `serverOrigin`, if any. */
  state(serverOrigin: string): Promise<PushState | null> {
    return this.read(serverOrigin, STATE_KEY);
  }

  private save(serverOrigin: string, state: PushState | null): Promise<void> {
    return state ? this.d.store.set(serverOrigin, STATE_KEY, JSON.stringify(state)) : this.d.store.remove(serverOrigin, STATE_KEY);
  }

  /** registerPush() for the server page at `serverOrigin`. */
  async register(serverOrigin: string): Promise<PushRegistration> {
    if (!(await this.d.pushAvailable())) throw new PushError('unavailable', 'Push notifications are not available in this build of the app.');
    if (!(await this.d.requestPermission())) throw new PushError('denied', 'Notifications are turned off for Arclight Admin. Allow them in the system settings.');

    let token: string;
    try {
      token = await this.d.getToken();
    } catch (err) {
      throw new PushError('unavailable', `Could not get a push token from the system: ${(err as Error)?.message ?? err}`);
    }

    let state = await this.state(serverOrigin);
    // A pre-0.24 shared device: this server now gets one of its own.
    if (state?.shared) state = null;
    if (state && state.token !== token) {
      // Token rotated since we registered: tell the relay; a 404 means the device is gone there.
      const ok = await this.updateToken(state, token).catch(() => false);
      state = ok ? { ...state, token } : null;
    }
    if (!state) {
      let res;
      try {
        res = await this.d.http({ method: 'POST', url: this.relay('/v1/devices'), headers: { 'content-type': 'application/json' }, data: { token, platform: this.d.platform, appId: this.d.appId, appVersion: this.d.appVersion, ...(this.d.platform === 'ios' ? { environment: await this.d.environment().catch(() => 'production' as const) } : {}) }, timeoutMs: RELAY_TIMEOUT_MS });
      } catch (err) {
        throw new PushError('relay', `Could not reach the push relay: ${(err as Error)?.message ?? err}`);
      }
      const body = asObject(res.data);
      if (res.status < 200 || res.status >= 300 || typeof body?.deviceId !== 'string' || typeof body?.secret !== 'string') {
        throw new PushError('relay', `The push relay refused the registration (HTTP ${res.status}).`);
      }
      state = { deviceId: body.deviceId, secret: body.secret, token };
    }
    await this.save(serverOrigin, state);
    return { relayDeviceId: state.deviceId, relaySecret: state.secret, platform: this.d.platform, deviceName: await this.d.deviceName().catch(() => (this.d.platform === 'ios' ? 'iPhone' : 'Android')), appId: this.d.appId };
  }

  /** PUT the new token. Resolves false when the relay no longer knows the device. */
  private async updateToken(state: PushState, token: string): Promise<boolean> {
    const res = await this.d.http({ method: 'PUT', url: this.relay(`/v1/devices/${encodeURIComponent(state.deviceId)}`), headers: { 'content-type': 'application/json', authorization: `Bearer ${state.secret}` }, data: { token }, timeoutMs: RELAY_TIMEOUT_MS });
    if (res.status === 404 || res.status === 401 || res.status === 403) return false;
    if (res.status < 200 || res.status >= 300) throw new Error(`relay answered HTTP ${res.status}`);
    return true;
  }

  /**
   * APNs/FCM handed us a (possibly new) token: keep the registrations of `serverOrigins` in sync.
   * The app's own screens pass every saved server; a server page only its own origin.
   */
  async onTokenRefresh(token: string, serverOrigins: readonly string[]): Promise<void> {
    const done = new Map<string, boolean>(); // deviceId -> updated (the shared device is PUT once)
    for (const origin of new Set(serverOrigins)) {
      const state = await this.state(origin);
      if (!state || state.token === token) continue;
      let ok = done.get(state.deviceId);
      if (ok === undefined) {
        ok = await this.updateToken(state, token).catch(() => false);
        done.set(state.deviceId, ok);
      }
      // When the relay forgot the device, keep the old state: the server still holds that id, and
      // the next registerPush from its page registers again and hands the server the new id.
      if (ok) await this.save(origin, { ...state, token });
    }
  }

  /** unregisterPush() from the server page at `serverOrigin` (or the server was removed). */
  async unregister(serverOrigin: string): Promise<void> {
    const state = await this.state(serverOrigin);
    if (!state) return;
    // The shared pre-0.24 device may still be used by other servers: reconcile() deletes it.
    if (!state.shared) {
      // Local state is cleared even if the relay cannot be reached (it drops tokens that
      // APNs/FCM report as invalid).
      try {
        await this.d.http({ method: 'DELETE', url: this.relay(`/v1/devices/${encodeURIComponent(state.deviceId)}`), headers: { authorization: `Bearer ${state.secret}` }, timeoutMs: RELAY_TIMEOUT_MS });
      } catch {
        /* best effort */
      }
    }
    await this.save(serverOrigin, null);
  }

  /** The registrations of `serverOrigins` (Settings shows the device IDs). */
  async states(serverOrigins: readonly string[]): Promise<Array<{ origin: string; state: PushState }>> {
    const out: Array<{ origin: string; state: PushState }> = [];
    for (const origin of new Set(serverOrigins)) {
      const state = await this.state(origin);
      if (state) out.push({ origin, state });
    }
    return out;
  }

  /**
   * App's own screens, on start: moves the pre-0.24 Preferences registration into the secure
   * store (one "shared" entry per server that used it). Idempotent.
   */
  async migrateLegacy(prefs: KeyValueStore): Promise<void> {
    const legacy = await readJson<LegacyState>(prefs, KEYS.push);
    if (!legacy) return;
    if (isState(legacy)) {
      const shared: PushState = { deviceId: legacy.deviceId, secret: legacy.secret, token: legacy.token, shared: true };
      await this.d.store.set('', LEGACY_KEY, JSON.stringify(shared));
      for (const origin of Array.isArray(legacy.servers) ? legacy.servers : []) {
        if (typeof origin === 'string' && !(await this.state(origin))) await this.save(origin, shared);
      }
    }
    await prefs.remove(KEYS.push);
  }

  /**
   * App's own screens: deletes the pre-0.24 shared device at the relay once none of the saved
   * servers uses it any more.
   */
  async reconcile(savedOrigins: readonly string[]): Promise<void> {
    const legacy = await this.read('', LEGACY_KEY);
    if (!legacy) return;
    for (const origin of new Set(savedOrigins)) {
      const s = await this.state(origin);
      if (s?.shared && s.deviceId === legacy.deviceId) return; // still in use
    }
    try {
      await this.d.http({ method: 'DELETE', url: this.relay(`/v1/devices/${encodeURIComponent(legacy.deviceId)}`), headers: { authorization: `Bearer ${legacy.secret}` }, timeoutMs: RELAY_TIMEOUT_MS });
    } catch {
      return; // try again next start
    }
    await this.d.store.remove('', LEGACY_KEY);
  }

  /** Removes the registration of every one of `serverOrigins` (Settings, "Remove push registration"). */
  async unregisterAll(serverOrigins: readonly string[]): Promise<void> {
    for (const origin of new Set(serverOrigins)) await this.unregister(origin);
    await this.reconcile([]);
  }
}
