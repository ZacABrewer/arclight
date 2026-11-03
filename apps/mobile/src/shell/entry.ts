import { Capacitor } from '@capacitor/core';
import { APP_VERSION } from '../config.js';
import { isSafePath } from '../core/routing.js';
import { serverForUrl } from '../core/servers.js';
import { appBuild, createShellRuntime, getNativeInfo, openExternal, openLocal, platform, pushService } from '../platform/capacitor.js';
import { installHandlers } from '../platform/handlers.js';
import { createArclightShell } from './contract.js';
import { showLockOverlay } from './lock-overlay.js';

// arclight-shell.js: injected by the native layer at document start into every page of a
// saved server (ArclightNativePlugin on iOS/Android), after Capacitor's own bridge script.
// It defines window.Capacitor.Plugins.ArclightShell before the server's web UI runs.
//
// This code runs in the server page's own JavaScript context, so it has no more rights than the
// page: the native bridge gate (ArclightNativePlugin) lets server pages reach only the plugin
// methods the shell needs, never Preferences or setServerOrigins. What the shell knows about the
// app comes from a read-only snapshot for this origin (createShellRuntime); anything that needs
// the full server list (a notification for another server) is handed back to the app's own screens.

declare global {
  interface Window {
    __ARCLIGHT_NATIVE__?: { localUrl?: string };
    __ARCLIGHT_SHELL__?: boolean;
  }
}

function install(): void {
  if (window.__ARCLIGHT_SHELL__) return;
  if (!Capacitor.isNativePlatform()) return;
  const local = window.__ARCLIGHT_NATIVE__?.localUrl;
  if (local && new URL(local).origin === window.location.origin) return; // the app's own screens
  window.__ARCLIGHT_SHELL__ = true;

  const push = pushService();
  const shell = createArclightShell({
    platform: platform(),
    appVersion: APP_VERSION,
    build: appBuild,
    pushAvailable: async () => (await getNativeInfo()).pushAvailable,
    push,
    currentServer: () => window.location.origin,
    openServerList: () => openLocal('#/servers'),
    openBrowser: openExternal,
  });
  const cap = (window as unknown as { Capacitor: { Plugins?: Record<string, unknown> } }).Capacitor;
  cap.Plugins = cap.Plugins ?? {};
  cap.Plugins.ArclightShell = shell;
  window.dispatchEvent(new Event('arclightshellready'));

  void createShellRuntime(push).then((rt) => {
    const currentServer = async () => serverForUrl(await rt.servers.list(), window.location.href);
    return installHandlers(rt, {
      currentServer,
      open: async (target) => {
        const path = target.url.slice(target.server.url.length) || '/';
        // Same origin: stay in place. Another server: the app's own screens select and open it.
        if (new URL(target.url).origin === window.location.origin) window.location.assign(target.url);
        else await openLocal(`#/open?id=${encodeURIComponent(target.server.id)}&path=${encodeURIComponent(isSafePath(path) ? path : '/')}`);
      },
      pair: (url) => openLocal(`#/add?url=${encodeURIComponent(url)}`),
      lock: showLockOverlay,
      pushScopes: async () => [window.location.origin],
      unrouted: (server, path) => openLocal(`#/open?id=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`),
    });
  });
}

try {
  install();
} catch (err) {
  console.error('[arclight-shell] failed to install', err);
}
