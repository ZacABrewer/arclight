import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, CapacitorHttp, WebPlugin, registerPlugin } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { APP_ID, APP_VERSION, KEYS, PUSH_RELAY_URL } from '../config.js';
import { originOf } from '../core/address.js';
import type { HttpClient } from '../core/http.js';
import type { KeyValueStore } from '../core/kv.js';
import { memoryStore } from '../core/kv.js';
import { PushService, type Platform, type ScopedStore } from '../core/push.js';
import { ServerStore, type Server } from '../core/servers.js';
import { loadSettings, type AppSettings } from '../core/settings.js';
import { TransportStore } from '../core/transport.js';

// Adapters from the core modules (plain TS, unit-tested) to Capacitor plugins. This file runs
// both in the app's own screens and, bundled as arclight-shell.js, inside the server's page.

/** App-local native plugin (ios/App/App/ArclightNativePlugin.swift, android/.../ArclightNativePlugin.java). */
export interface NativeInfo {
  pushAvailable: boolean;
  localUrl: string;
  /** APNs environment: 'sandbox' for debug (development-signed) iOS builds, else 'production'. */
  pushEnvironment: 'production' | 'sandbox';
}

/** What a server page may know about the app (handed over per origin by the app's own screens). */
export interface ShellSnapshot {
  /** The saved servers at this origin (several when they differ only by base path). */
  servers: Server[];
  settings: AppSettings;
}

export interface ArclightNativePlugin {
  /**
   * App's own screens only (the native bridge gate refuses it from server pages). origins: the
   * saved servers that may open in place and get the native shell; only origins that passed the
   * cleartext policy (core/transport.ts) are listed. shell: what each of them may read with
   * shellState(). relayUrl: the push relay, the one host server pages may reach through
   * CapacitorHttp.
   */
  setServerOrigins(options: { origins: string[]; shell?: Record<string, ShellSnapshot>; relayUrl?: string }): Promise<void>;
  /** pushAvailable: the build can receive push (Android: google-services.json was present). localUrl: the app's own origin. */
  getInfo(): Promise<NativeInfo>;
  /** Server pages: the snapshot for the calling page's origin (the native layer picks it). */
  shellState(): Promise<{ state: ShellSnapshot | null }>;
  /**
   * Secret storage (Keychain / Android Keystore). scope: a server origin, or '' for the app.
   * From a server page the native layer replaces scope with that page's own origin.
   */
  secureGet(options: { scope: string; key: string }): Promise<{ value: string | null }>;
  secureSet(options: { scope: string; key: string; value: string }): Promise<void>;
  secureRemove(options: { scope: string; key: string }): Promise<void>;
}

class ArclightNativeWeb extends WebPlugin implements ArclightNativePlugin {
  private secure = new Map<string, string>();
  async setServerOrigins(): Promise<void> {}
  async getInfo() {
    return { pushAvailable: false, localUrl: window.location.origin, pushEnvironment: 'production' as const };
  }
  async shellState() {
    return { state: null };
  }
  async secureGet(o: { scope: string; key: string }) {
    return { value: this.secure.get(`${o.scope}\n${o.key}`) ?? null };
  }
  async secureSet(o: { scope: string; key: string; value: string }) {
    this.secure.set(`${o.scope}\n${o.key}`, o.value);
  }
  async secureRemove(o: { scope: string; key: string }) {
    this.secure.delete(`${o.scope}\n${o.key}`);
  }
}

export const ArclightNative = registerPlugin<ArclightNativePlugin>('ArclightNative', { web: () => new ArclightNativeWeb() });

export const secureStore: ScopedStore = {
  get: async (scope, key) => (await ArclightNative.secureGet({ scope, key })).value ?? null,
  set: (scope, key, value) => ArclightNative.secureSet({ scope, key, value }),
  remove: (scope, key) => ArclightNative.secureRemove({ scope, key }),
};

export const preferencesStore: KeyValueStore = {
  get: async (key) => (await Preferences.get({ key })).value,
  set: (key, value) => Preferences.set({ key, value }),
  remove: (key) => Preferences.remove({ key }),
};

export const nativeHttp: HttpClient = async (req) => {
  const res = await CapacitorHttp.request({
    method: req.method,
    url: req.url,
    headers: { accept: 'application/json', ...(req.headers ?? {}) },
    ...(req.data !== undefined ? { data: req.data } : {}),
    responseType: 'json',
    ...(req.timeoutMs ? { connectTimeout: req.timeoutMs, readTimeout: req.timeoutMs } : {}),
  });
  return { status: res.status, url: res.url || req.url, data: res.data };
};

export function platform(): Platform {
  return Capacitor.getPlatform() === 'ios' ? 'ios' : 'android';
}

export const isNative = () => Capacitor.isNativePlatform();

let nativeInfo: Promise<NativeInfo> | null = null;
export function getNativeInfo(): Promise<NativeInfo> {
  nativeInfo ??= ArclightNative.getInfo().catch(() => ({ pushAvailable: false, localUrl: window.location.origin, pushEnvironment: 'production' as const }));
  return nativeInfo;
}

/** Resolves to the next APNs/FCM token after calling register(). */
function pushToken(timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const handles: Array<Promise<{ remove: () => Promise<void> }>> = [];
    const done = (fn: () => void) => {
      clearTimeout(timer);
      for (const h of handles) void h.then((x) => x.remove());
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('timed out waiting for a push token'))), timeoutMs);
    handles.push(PushNotifications.addListener('registration', (t) => done(() => resolve(t.value))));
    handles.push(PushNotifications.addListener('registrationError', (e) => done(() => reject(new Error(e.error)))));
    PushNotifications.register().catch((e: unknown) => done(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}

/** The current push token, without asking for permission (null when push is not granted). */
export async function currentPushToken(): Promise<string | null> {
  if (!isNative() || !(await getNativeInfo()).pushAvailable) return null;
  const perm = await PushNotifications.checkPermissions().catch(() => null);
  if (perm?.receive !== 'granted') return null;
  return pushToken().catch(() => null);
}

export async function requestNotificationPermission(): Promise<boolean> {
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await PushNotifications.requestPermissions();
  return perm.receive === 'granted';
}

export async function deviceName(): Promise<string> {
  const info = await Device.getInfo();
  // iOS 16+ reports a generic name ("iPhone") without a special entitlement; fine as a label.
  return info.name?.trim() || info.model || (platform() === 'ios' ? 'iPhone' : 'Android');
}

export async function openExternal(url: string): Promise<void> {
  if (/^https?:/i.test(url)) await Browser.open({ url });
  else window.location.href = url; // mailto:/tel: are handed to the OS by the WebView
}

export async function appBuild(): Promise<string> {
  if (!isNative()) return 'dev';
  return (await App.getInfo()).build;
}

export interface Runtime {
  kv: KeyValueStore;
  http: HttpClient;
  servers: ServerStore;
  push: PushService;
  transport: TransportStore;
  platform: Platform;
  /** Hands the allowed origins and the server pages' snapshots to the native layer. */
  syncNative: () => Promise<void>;
}

/** Push registrations, kept in the secure store (scoped per server origin by native). */
export function pushService(): PushService {
  return new PushService({
    store: secureStore,
    http: nativeHttp,
    relayUrl: PUSH_RELAY_URL,
    platform: platform(),
    appId: APP_ID,
    appVersion: APP_VERSION,
    pushAvailable: async () => isNative() && (await getNativeInfo()).pushAvailable,
    requestPermission: requestNotificationPermission,
    getToken: () => pushToken(),
    deviceName,
    environment: async () => (await getNativeInfo()).pushEnvironment ?? 'production',
  });
}

/** The app's own screens: Preferences-backed, full access. */
export function createRuntime(): Runtime {
  const kv = preferencesStore;
  const servers = new ServerStore(kv);
  const transport = new TransportStore(kv);
  return {
    kv,
    http: nativeHttp,
    servers,
    push: pushService(),
    transport,
    platform: platform(),
    syncNative: async () => syncServerOrigins(await servers.list(), transport, await loadSettings(kv)),
  };
}

/**
 * Inside a server page: no Preferences (the native gate refuses it there). Servers and settings
 * come from the read-only snapshot the app's own screens handed over for this origin; changes
 * stay in memory. Push credentials go through the secure store, scoped to this origin by native.
 */
export async function createShellRuntime(push: PushService = pushService()): Promise<Runtime> {
  const snapshot = (await ArclightNative.shellState().catch(() => ({ state: null }))).state;
  const kv = memoryStore({
    [KEYS.servers]: JSON.stringify({ version: 1, servers: snapshot?.servers ?? [], selectedId: snapshot?.servers[0]?.id ?? null }),
    ...(snapshot?.settings ? { [KEYS.settings]: JSON.stringify(snapshot.settings) } : {}),
  });
  return {
    kv,
    http: nativeHttp,
    servers: new ServerStore(kv),
    push,
    transport: new TransportStore(kv),
    platform: platform(),
    syncNative: async () => undefined,
  };
}

/**
 * Hands the native layer the origins that may open in place (only those the cleartext policy
 * allows) and, per origin, what its pages may read.
 */
export async function syncServerOrigins(servers: readonly Server[], transport: TransportStore, settings: AppSettings): Promise<void> {
  const origins = await transport.allowedOrigins(servers.map((s) => s.url));
  const shell: Record<string, ShellSnapshot> = {};
  for (const origin of origins) shell[origin] = { servers: servers.filter((s) => originOf(s.url) === origin), settings };
  await ArclightNative.setServerOrigins({ origins, shell, relayUrl: PUSH_RELAY_URL }).catch(() => undefined);
}

/** Navigates the WebView to a server page (after making sure native lets it load in place). */
export async function openInWebView(rt: Runtime, url: string): Promise<void> {
  await rt.syncNative();
  // replace(): the app's launch page must not stay in the history, or Android's back button on
  // the server's first page would return to it and it would open the server again.
  window.location.replace(url);
}

/** Back to the app's own screens (from a server page). */
export async function openLocal(hash: string): Promise<void> {
  const { localUrl } = await getNativeInfo();
  window.location.replace(`${localUrl.replace(/\/+$/, '')}/index.html${hash}`);
}
