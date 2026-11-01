import { KEYS } from '../config.js';
import type { HttpClient } from './http.js';
import { readJson, writeJson, type KeyValueStore } from './kv.js';

// Push registration with the Arclight push relay.
//
//   POST   {relay}/v1/devices            { token, platform, appVersion, environment? } -> { deviceId, secret }
//          environment (iOS only): 'sandbox' for development-signed builds, 'production' otherwise.
//   PUT    {relay}/v1/devices/{id}       { token }   Authorization: Bearer {secret}  (token rotated)
//   DELETE {relay}/v1/devices/{id}                   Authorization: Bearer {secret}
//
// One relay device per app install, shared by every saved server: each server that calls
// registerPush gets the same { relayDeviceId, relaySecret } and stores it for its user. The
// device is deleted at the relay only when the last server that registered it unregisters
// (or is removed from the app), so turning push off on one server does not break the others.

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

export interface PushState {
  deviceId: string;
  secret: string;
  token: string;
  /** Origins (server base URLs) that registered this device. */
  servers: string[];
}

export interface PushDeps {
  kv: KeyValueStore;
  http: HttpClient;
  relayUrl: string;
  platform: Platform;
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

export class PushService {
  constructor(private readonly d: PushDeps) {}

  private relay(path: string): string {
    return `${this.d.relayUrl.replace(/\/+$/, '')}${path}`;
  }

  state(): Promise<PushState | null> {
    return readJson<PushState>(this.d.kv, KEYS.push);
  }

  private save(state: PushState | null): Promise<void> {
    return state ? writeJson(this.d.kv, KEYS.push, state) : this.d.kv.remove(KEYS.push);
  }

  /** registerPush() for the server page at `serverOrigin`. */
  async register(serverOrigin: string): Promise<PushRegistration> {
    if (!(await this.d.pushAvailable())) throw new PushError('unavailable', 'Push notifications are not available in this build of the app.');
    if (!(await this.d.requestPermission())) throw new PushError('denied', 'Notifications are turned off for Arclight. Allow them in the system settings.');

    let token: string;
    try {
      token = await this.d.getToken();
    } catch (err) {
      throw new PushError('unavailable', `Could not get a push token from the system: ${(err as Error)?.message ?? err}`);
    }

    let state = await this.state();
    if (state && state.token !== token) {
      // Token rotated since we registered: tell the relay; a 404 means the device is gone there.
      const ok = await this.updateToken(state, token).catch(() => false);
      if (!ok) state = null;
    }
    if (!state) {
      let res;
      try {
        res = await this.d.http({ method: 'POST', url: this.relay('/v1/devices'), headers: { 'content-type': 'application/json' }, data: { token, platform: this.d.platform, appVersion: this.d.appVersion, ...(this.d.platform === 'ios' ? { environment: await this.d.environment().catch(() => 'production' as const) } : {}) }, timeoutMs: RELAY_TIMEOUT_MS });
      } catch (err) {
        throw new PushError('relay', `Could not reach the push relay: ${(err as Error)?.message ?? err}`);
      }
      const body = asObject(res.data);
      if (res.status < 200 || res.status >= 300 || typeof body?.deviceId !== 'string' || typeof body?.secret !== 'string') {
        throw new PushError('relay', `The push relay refused the registration (HTTP ${res.status}).`);
      }
      state = { deviceId: body.deviceId, secret: body.secret, token, servers: [] };
    }
    if (!state.servers.includes(serverOrigin)) state.servers.push(serverOrigin);
    await this.save(state);
    return { relayDeviceId: state.deviceId, relaySecret: state.secret, platform: this.d.platform, deviceName: await this.d.deviceName().catch(() => (this.d.platform === 'ios' ? 'iPhone' : 'Android')) };
  }

  /** PUT the new token. Resolves false when the relay no longer knows the device. */
  private async updateToken(state: PushState, token: string): Promise<boolean> {
    const res = await this.d.http({ method: 'PUT', url: this.relay(`/v1/devices/${encodeURIComponent(state.deviceId)}`), headers: { 'content-type': 'application/json', authorization: `Bearer ${state.secret}` }, data: { token }, timeoutMs: RELAY_TIMEOUT_MS });
    if (res.status === 404 || res.status === 401 || res.status === 403) return false;
    if (res.status < 200 || res.status >= 300) throw new Error(`relay answered HTTP ${res.status}`);
    return true;
  }

  /** APNs/FCM handed us a (possibly new) token: keep the relay in sync. */
  async onTokenRefresh(token: string): Promise<void> {
    const state = await this.state();
    if (!state || state.token === token) return;
    const ok = await this.updateToken(state, token);
    // When the relay forgot the device, keep the old state: servers still hold that id, and the
    // next registerPush from a server page re-registers and hands the server the new id.
    if (ok) await this.save({ ...state, token });
  }

  /** unregisterPush() from the server page at `serverOrigin` (or the server was removed). */
  async unregister(serverOrigin: string | null): Promise<void> {
    const state = await this.state();
    if (!state) return;
    const servers = serverOrigin === null ? [] : state.servers.filter((s) => s !== serverOrigin);
    if (servers.length > 0) {
      await this.save({ ...state, servers });
      return;
    }
    // Last user of the device: delete it at the relay. Local state is cleared even if the relay
    // cannot be reached (it drops tokens that APNs/FCM report as invalid).
    try {
      await this.d.http({ method: 'DELETE', url: this.relay(`/v1/devices/${encodeURIComponent(state.deviceId)}`), headers: { authorization: `Bearer ${state.secret}` }, timeoutMs: RELAY_TIMEOUT_MS });
    } catch {
      /* best effort */
    }
    await this.save(null);
  }
}
