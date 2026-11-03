// Build-time constants. Nothing here is secret: the push relay URL is public and every
// request to it is authenticated per device (POST returns a device secret).

declare const __APP_VERSION__: string;

/** Marketing version (package.json "version"); the native build number comes from App.getInfo(). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';

/**
 * Bundle ID / application ID of this app (capacitor.config.ts appId; keep the two equal). The
 * push relay picks the APNs topic from it, so it is sent with the relay registration and handed
 * to the server with registerPush(). The separate player app "Arclight" is com.moviemethat.arclight.
 */
export const APP_ID = 'com.moviemethat.arclight.admin';

/** Push relay base URL. Override at build time with VITE_PUSH_RELAY_URL (forks running their own relay). */
export const PUSH_RELAY_URL: string = (import.meta.env?.VITE_PUSH_RELAY_URL as string | undefined) || 'https://arclight-push.moviemethat.com';

/** Arclight's default listen port. */
export const DEFAULT_PORT = 7878;

/** Time allowed for each probe request while adding or opening a server. */
export const PROBE_TIMEOUT_MS = 6000;

export const LINKS = {
  privacy: 'https://arclight.moviemethat.com/legal/privacy/',
  support: 'https://arclight.moviemethat.com/support/',
  website: 'https://arclight.moviemethat.com/',
  source: 'https://github.com/ZacABrewer/arclight',
  license: 'https://www.gnu.org/licenses/gpl-3.0.html',
  tmdb: 'https://www.themoviedb.org/',
} as const;

/**
 * Capacitor Preferences keys (stored in UserDefaults / SharedPreferences "CapacitorStorage").
 * Server pages cannot reach Preferences at all (the native bridge gate refuses it), so these are
 * written by the app's own screens only. Secrets (push relay credentials) are not kept here but in
 * the native secure store (Keychain / Android Keystore), see platform/capacitor.ts.
 */
export const KEYS = {
  servers: 'arclight.servers',
  settings: 'arclight.settings',
  /** Before 0.24: the one shared push registration. Moved to the secure store on first start. */
  push: 'arclight.push',
  pendingRoute: 'arclight.pendingRoute',
  /** Plain-http notices / confirmations and https-pinned hosts (core/transport.ts). */
  transport: 'arclight.transport',
} as const;
