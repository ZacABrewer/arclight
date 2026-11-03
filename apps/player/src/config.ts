/** App version (package.json), injected by Vite. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** Arclight's default port (what the server listens on unless changed). */
export const DEFAULT_PORT = 7878;

/** How long one address probe may take before it counts as "no answer". */
export const PROBE_TIMEOUT_MS = 6_000;

/** API requests that take longer than this are treated as "server unreachable" (offline mode). */
export const REQUEST_TIMEOUT_MS = 15_000;
