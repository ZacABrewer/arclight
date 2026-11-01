import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, CapacitorHttp, WebPlugin, registerPlugin } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { APP_VERSION, PUSH_RELAY_URL } from '../config.js';
import { originOf } from '../core/address.js';
import type { HttpClient } from '../core/http.js';
import type { KeyValueStore } from '../core/kv.js';
import { PushService, type Platform } from '../core/push.js';
import { ServerStore, type Server } from '../core/servers.js';

// Adapters from the core modules (plain TS, unit-tested) to Capacitor plugins. This file runs
// both in the app's own screens and, bundled as arclight-shell.js, inside the server's page.

/** App-local native plugin (ios/App/App/ArclightNativePlugin.swift, android/.../ArclightNativePlugin.java). */
export interface NativeInfo {
  pushAvailable: boolean;
  localUrl: string;
  /** APNs environment: 'sandbox' for debug (development-signed) iOS builds, else 'production'. */
  pushEnvironment: 'production' | 'sandbox';
}

export interface ArclightNativePlugin {
  /** Origins the WebView may open in place (and, on Android, that get the Capacitor bridge). */
  setServerOrigins(options: { origins: string[] }): Promise<void>;
  /** pushAvailable: the build can receive push (Android: google-services.json was present). localUrl: the app's own origin. */
  getInfo(): Promise<NativeInfo>;
}

class ArclightNativeWeb extends WebPlugin implements ArclightNativePlugin {
  async setServerOrigins(): Promise<void> {}
  async getInfo() {
    return { pushAvailable: false, localUrl: window.location.origin, pushEnvironment: 'production' as const };
  }
}

export const ArclightNative = registerPlugin<ArclightNativePlugin>('ArclightNative', { web: () => new ArclightNativeWeb() });

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
  platform: Platform;
}

export function createRuntime(): Runtime {
  const kv = preferencesStore;
  const servers = new ServerStore(kv);
  const push = new PushService({
    kv,
    http: nativeHttp,
    relayUrl: PUSH_RELAY_URL,
    platform: platform(),
    appVersion: APP_VERSION,
    pushAvailable: async () => isNative() && (await getNativeInfo()).pushAvailable,
    requestPermission: requestNotificationPermission,
    getToken: () => pushToken(),
    deviceName,
    environment: async () => (await getNativeInfo()).pushEnvironment ?? 'production',
  });
  return { kv, http: nativeHttp, servers, push, platform: platform() };
}

/** Hands the saved servers' origins to the native navigation allow-list. */
export async function syncServerOrigins(servers: readonly Server[]): Promise<void> {
  const origins = [...new Set(servers.map((s) => originOf(s.url)))];
  await ArclightNative.setServerOrigins({ origins }).catch(() => undefined);
}

/** Navigates the WebView to a server page (after making sure native lets it load in place). */
export async function openInWebView(rt: Runtime, url: string): Promise<void> {
  await syncServerOrigins(await rt.servers.list());
  // replace(): the app's launch page must not stay in the history, or Android's back button on
  // the server's first page would return to it and it would open the server again.
  window.location.replace(url);
}

/** Back to the app's own screens (from a server page). */
export async function openLocal(hash: string): Promise<void> {
  const { localUrl } = await getNativeInfo();
  window.location.replace(`${localUrl.replace(/\/+$/, '')}/index.html${hash}`);
}
