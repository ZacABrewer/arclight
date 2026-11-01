import type { Platform, PushRegistration, PushService } from '../core/push.js';

// window.Capacitor.Plugins.ArclightShell: what the Arclight web UI served by the user's server
// can ask of the app. The web side (apps/web) is written against exactly these names; do not
// rename or change shapes without changing both sides.

export interface ArclightShellInfo {
  platform: Platform;
  appVersion: string;
  build: string;
  pushAvailable: boolean;
}

export interface ArclightShellPlugin {
  info(): Promise<ArclightShellInfo>;
  /** Rejects with { code: 'denied' | 'unavailable' | 'relay', message }. */
  registerPush(): Promise<PushRegistration>;
  unregisterPush(): Promise<void>;
  /** Back to the app's server list. */
  switchServer(): Promise<void>;
  /** Opens a URL in the system browser. */
  openExternal(options: { url: string }): Promise<void>;
}

export interface ShellDeps {
  platform: Platform;
  appVersion: string;
  /** Native build number (CFBundleVersion / versionCode). */
  build: () => Promise<string>;
  pushAvailable: () => Promise<boolean>;
  push: PushService;
  /** Origin + base path of the server whose page is calling. */
  currentServer: () => string;
  openServerList: () => Promise<void>;
  openBrowser: (url: string) => Promise<void>;
}

/** A plain error object the web page can read across the bridge: { code, message }. */
function rejection(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

export function createArclightShell(d: ShellDeps): ArclightShellPlugin {
  return {
    async info() {
      const [build, pushAvailable] = await Promise.all([d.build().catch(() => '0'), d.pushAvailable().catch(() => false)]);
      return { platform: d.platform, appVersion: d.appVersion, build, pushAvailable };
    },
    async registerPush() {
      try {
        return await d.push.register(d.currentServer());
      } catch (err) {
        const code = (err as { code?: string })?.code;
        throw rejection(code === 'denied' || code === 'unavailable' || code === 'relay' ? code : 'unavailable', (err as Error)?.message ?? String(err));
      }
    },
    async unregisterPush() {
      await d.push.unregister(d.currentServer());
    },
    async switchServer() {
      await d.openServerList();
    },
    async openExternal(options) {
      const url = options?.url;
      let parsed: URL;
      try {
        parsed = new URL(String(url));
      } catch {
        throw rejection('invalid', 'openExternal needs an absolute URL.');
      }
      if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) throw rejection('invalid', `openExternal does not open ${parsed.protocol} links.`);
      await d.openBrowser(parsed.toString());
    },
  };
}
