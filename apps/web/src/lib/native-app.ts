import type { MobilePlatform } from '@arclight/shared';

// Bridge to Arclight Admin, the companion app (apps/mobile). The app's WebView loads this server's
// UI; its user agent carries ` ArclightApp/<version> (<ios|android>)` and it exposes the
// Capacitor plugin `window.Capacitor.Plugins.ArclightShell`. In a plain browser none of this
// exists: every helper here then answers "not in the app" / null and never throws, so callers
// simply hide the app-only features.

export interface ShellInfo {
  platform: MobilePlatform;
  appVersion: string;
  build: string;
  pushAvailable: boolean;
}

export interface ShellPushRegistration {
  relayDeviceId: string;
  relaySecret: string;
  platform: MobilePlatform;
  deviceName: string;
  /** The app's bundle ID (Arclight Admin and later apps); older app builds leave it out. */
  appId?: string;
}

/** What registerPush() rejects with. */
export interface ShellError {
  code: 'denied' | 'unavailable' | 'relay';
  message: string;
}

export interface ArclightShellPlugin {
  info(): Promise<ShellInfo>;
  registerPush(): Promise<ShellPushRegistration>;
  unregisterPush(): Promise<void>;
  switchServer(): Promise<void>;
  openExternal(options: { url: string }): Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { ArclightShell?: ArclightShellPlugin };
}

type NativeWindow = Window & { Capacitor?: CapacitorGlobal };

const UA_RE = /\bArclightApp\/([^\s)]+)(?:\s*\((ios|android)\))?/i;

/** The app's version and platform from a user agent; null outside the app. */
export function parseAppUserAgent(ua: string): { version: string; platform: MobilePlatform | null } | null {
  const m = UA_RE.exec(ua);
  if (!m) return null;
  const platform = m[2]?.toLowerCase();
  return { version: m[1]!, platform: platform === 'ios' || platform === 'android' ? platform : null };
}

function win(): NativeWindow | undefined {
  return typeof window === 'undefined' ? undefined : (window as NativeWindow);
}

/** True inside the Arclight Admin app (user agent or Capacitor native platform). */
export function isInApp(w: NativeWindow | undefined = win()): boolean {
  if (!w) return false;
  if (parseAppUserAgent(w.navigator?.userAgent ?? '')) return true;
  try {
    return w.Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/** The ArclightShell plugin, or null (plain browser, or an app build without it). */
export function shell(w: NativeWindow | undefined = win()): ArclightShellPlugin | null {
  try {
    const plugin = w?.Capacitor?.Plugins?.ArclightShell;
    return plugin && typeof plugin.info === 'function' ? plugin : null;
  } catch {
    return null;
  }
}

/** The app's info, or null outside the app or when the plugin fails. */
export async function shellInfo(w?: NativeWindow): Promise<ShellInfo | null> {
  const plugin = shell(w);
  if (!plugin) return null;
  try {
    return await plugin.info();
  } catch {
    return null;
  }
}

/** A readable message for a registerPush() rejection (plugin errors are plain objects). */
export function shellErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') return (err as ShellError).message;
  return String(err);
}

export function shellErrorCode(err: unknown): ShellError['code'] | null {
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : null;
  return code === 'denied' || code === 'unavailable' || code === 'relay' ? code : null;
}

/** Ask the app to show its server picker. False when there is no app to ask. */
export async function switchServer(w?: NativeWindow): Promise<boolean> {
  const plugin = shell(w);
  if (!plugin) return false;
  await plugin.switchServer();
  return true;
}

/** Open `url` in the system browser through the app. False when there is no app (the caller opens it normally). */
export async function openExternal(url: string, w?: NativeWindow): Promise<boolean> {
  const plugin = shell(w);
  if (!plugin) return false;
  try {
    await plugin.openExternal({ url });
    return true;
  } catch {
    return false;
  }
}

/** Whether a click on this anchor should leave the app for the system browser. */
export function isExternalLink(a: HTMLAnchorElement, origin: string): boolean {
  const href = a.getAttribute('href');
  if (!href || href.startsWith('#') || a.hasAttribute('download')) return false;
  let url: URL;
  try {
    url = new URL(a.href, origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return false;
  return url.origin !== origin || a.target === '_blank';
}

/**
 * In-app mode: marks <html> with `in-app` (and `in-app--ios` / `in-app--android`) so CSS can
 * apply safe areas and hide browser-only UI, and routes external links (other origins or
 * target=_blank) through ArclightShell.openExternal. No-op in a plain browser. Returns an
 * undo function (tests).
 */
export function installInAppMode(w: NativeWindow | undefined = win()): () => void {
  if (!w || !isInApp(w)) return () => undefined;
  const root = w.document.documentElement;
  const platform = parseAppUserAgent(w.navigator.userAgent)?.platform;
  root.classList.add('in-app');
  if (platform) root.classList.add(`in-app--${platform}`);
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a || !isExternalLink(a as HTMLAnchorElement, w.location.origin)) return;
    const plugin = shell(w);
    if (!plugin) return;
    e.preventDefault();
    const href = (a as HTMLAnchorElement).href;
    void openExternal(href, w).then((ok) => {
      if (!ok) w.open(href, '_blank', 'noopener');
    });
  };
  w.document.addEventListener('click', onClick, true);
  return () => {
    w.document.removeEventListener('click', onClick, true);
    root.classList.remove('in-app', 'in-app--ios', 'in-app--android');
  };
}
