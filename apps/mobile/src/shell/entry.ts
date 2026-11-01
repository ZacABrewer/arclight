import { Capacitor } from '@capacitor/core';
import { APP_VERSION } from '../config.js';
import { serverForUrl } from '../core/servers.js';
import { appBuild, createRuntime, getNativeInfo, openExternal, openInWebView, openLocal } from '../platform/capacitor.js';
import { installHandlers } from '../platform/handlers.js';
import { createArclightShell } from './contract.js';
import { showLockOverlay } from './lock-overlay.js';

// arclight-shell.js: injected by the native layer at document start into every page of a
// saved server (ArclightNativePlugin on iOS/Android), after Capacitor's own bridge script.
// It defines window.Capacitor.Plugins.ArclightShell before the server's web UI runs.

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

  const rt = createRuntime();
  const shell = createArclightShell({
    platform: rt.platform,
    appVersion: APP_VERSION,
    build: appBuild,
    pushAvailable: async () => (await getNativeInfo()).pushAvailable,
    push: rt.push,
    currentServer: () => window.location.origin,
    openServerList: () => openLocal('#/servers'),
    openBrowser: openExternal,
  });
  const cap = (window as unknown as { Capacitor: { Plugins?: Record<string, unknown> } }).Capacitor;
  cap.Plugins = cap.Plugins ?? {};
  cap.Plugins.ArclightShell = shell;

  const currentServer = async () => serverForUrl(await rt.servers.list(), window.location.href);
  void installHandlers(rt, {
    currentServer,
    open: async (target) => {
      await rt.servers.select(target.server.id);
      await openInWebView(rt, target.url);
    },
    pair: (url) => openLocal(`#/add?url=${encodeURIComponent(url)}`),
    lock: showLockOverlay,
  });

  window.dispatchEvent(new Event('arclightshellready'));
}

try {
  install();
} catch (err) {
  console.error('[arclight-shell] failed to install', err);
}
