import { App } from '@capacitor/app';
import { PushNotifications } from '@capacitor/push-notifications';
import { CapacitorShareTarget } from '@capgo/capacitor-share-target';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import { parsePairingCode } from '../core/qr.js';
import { discoverSearchPath, routeNotification, shareQuery, type RouteTarget } from '../core/routing.js';
import type { Server } from '../core/servers.js';
import { loadSettings, shouldLockOnResume } from '../core/settings.js';
import { isNative, platform, type Runtime } from './capacitor.js';

// App-wide events, handled the same way on the app's own screens and inside a server page:
// push token rotation, notification taps, shares, pairing links and the biometric lock.

export interface HandlerHooks {
  /** The server the current page belongs to (null on the app's own screens). */
  currentServer: () => Promise<Server | null>;
  /** Open a server page (switching the selected server when needed). */
  open: (target: RouteTarget) => Promise<void> | void;
  /** A pairing link (arclight://pair?url=...) was opened. */
  pair: (url: string) => Promise<void> | void;
  /** Show the lock and resolve once unlocked. */
  lock: () => Promise<void>;
}

export const NOTIFICATION_CHANNELS = [
  { id: 'requests', name: 'Requests', description: 'New, approved and available requests', importance: 4 as const },
  { id: 'downloads', name: 'Downloads', description: 'Grabs, imports and failed downloads', importance: 3 as const },
  { id: 'health', name: 'Server health', description: 'Problems your Arclight server reports', importance: 4 as const },
  { id: 'general', name: 'General', description: 'Other notifications from your server', importance: 3 as const },
];

export async function ensureNotificationChannels(): Promise<void> {
  if (platform() !== 'android' || !isNative()) return;
  for (const c of NOTIFICATION_CHANNELS) {
    await PushNotifications.createChannel({ id: c.id, name: c.name, description: c.description, importance: c.importance, visibility: 0 }).catch(() => undefined);
  }
}

export async function verifyBiometric(reason: string): Promise<boolean> {
  try {
    await NativeBiometric.verifyIdentity({ reason, title: 'Unlock Arclight', subtitle: reason, negativeButtonText: 'Cancel', useFallback: true, maxAttempts: 5 });
    return true;
  } catch {
    return false;
  }
}

export async function biometricAvailable(): Promise<{ available: boolean; label: string }> {
  try {
    const r = await NativeBiometric.isAvailable({ useFallback: true });
    // BiometryType: 1 touch id, 2 face id, 3 fingerprint, 4 face, 5 iris, 6 multiple
    const label = ({ 1: 'Touch ID', 2: 'Face ID', 3: 'Fingerprint' } as Record<number, string>)[r.biometryType as unknown as number] ?? (platform() === 'ios' ? 'Face ID / Touch ID' : 'Biometric unlock');
    return { available: r.isAvailable, label };
  } catch {
    return { available: false, label: 'Biometric unlock' };
  }
}

export async function installHandlers(rt: Runtime, hooks: HandlerHooks): Promise<void> {
  if (!isNative()) return;

  // Push token rotated by APNs/FCM: keep the relay in sync (no-op when unchanged).
  void PushNotifications.addListener('registration', (t) => void rt.push.onTokenRefresh(t.value).catch(() => undefined));

  // Notification tapped: data.url (a path) on data.server (a saved server's base URL).
  void PushNotifications.addListener('pushNotificationActionPerformed', async (action) => {
    const data = (action.notification?.data ?? {}) as Record<string, unknown>;
    const servers = await rt.servers.list();
    const fallback = (await hooks.currentServer()) ?? (await rt.servers.selected());
    const target = routeNotification(data, servers, fallback);
    if (target) await hooks.open(target);
  });

  // Shared text / IMDb / TMDB link: discover search on the current (or selected) server.
  if (platform() === 'android') {
    void CapacitorShareTarget.addListener('shareReceived', async (e) => {
      const q = shareQuery(e.title, e.texts ?? []);
      const server = (await hooks.currentServer()) ?? (await rt.servers.selected());
      if (q && server) await hooks.open({ server, url: `${server.url}${discoverSearchPath(q)}` });
    }).catch(() => undefined);
  }

  // arclight://pair?url=... opened from the camera app or a link.
  void App.addListener('appUrlOpen', (e) => {
    const url = parsePairingCode(e.url);
    if (url) void hooks.pair(url);
  });

  // Biometric lock after the configured time in the background.
  let backgroundedAt: number | null = null;
  let locking = false;
  void App.addListener('appStateChange', async ({ isActive }) => {
    if (!isActive) {
      backgroundedAt ??= Date.now();
      return;
    }
    const since = backgroundedAt;
    backgroundedAt = null;
    if (locking) return;
    if (shouldLockOnResume(await loadSettings(rt.kv), since, Date.now())) {
      locking = true;
      try {
        await hooks.lock();
      } finally {
        locking = false;
      }
    }
  });
}
