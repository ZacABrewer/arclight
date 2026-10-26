import type { PushSubscriptionInput } from '@arclight/shared';
import { pushApi } from '../api/push.js';
import { t } from '../i18n/index.js';

// Browser side of web push: permission, PushManager subscription and the api calls that
// register it. The service worker (public/sw.js) shows the notifications.

export type PushSupport = 'supported' | 'unsupported' | 'insecure';

export function pushSupport(win: Window & typeof globalThis = window): PushSupport {
  if (!('serviceWorker' in win.navigator) || !('PushManager' in win) || !('Notification' in win)) return 'unsupported';
  if (!win.isSecureContext) return 'insecure';
  return 'supported';
}

/** base64url (VAPID public key) → bytes for applicationServerKey. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** PushSubscription.toJSON() → the api body. */
export function toSubscriptionInput(json: PushSubscriptionJSON, userAgent?: string): PushSubscriptionInput {
  if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys['auth']) throw new Error(t('lib.webPush.theBrowserReturnedAnIncomplete'));
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] },
    ...(userAgent ? { userAgent: userAgent.slice(0, 512) } : {}),
  };
}

/** The service worker registration; registers /sw.js when the app did not (dev builds). */
export async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await serviceWorkerRegistration();
  return reg.pushManager.getSubscription();
}

/** Ask for permission, subscribe with the server's VAPID key and register the subscription. */
export async function enablePush(): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? t('lib.webPush.notificationsAreBlockedForThis') : t('lib.webPush.notificationPermissionWasNotGranted'));
  const reg = await serviceWorkerRegistration();
  const { publicKey } = await pushApi.publicKey();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await pushApi.subscribe(toSubscriptionInput(sub.toJSON(), navigator.userAgent));
  return sub;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await pushApi.unsubscribe(endpoint).catch(() => undefined);
}

function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const key = sub.options.applicationServerKey;
  if (!key) return true;
  const a = new Uint8Array(key);
  const b = urlBase64ToUint8Array(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
