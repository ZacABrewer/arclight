/** App version (package.json), injected by Vite. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** Arclight's default port (what the server listens on unless changed). */
export const DEFAULT_PORT = 7878;

/** How long one address probe may take before it counts as "no answer". */
export const PROBE_TIMEOUT_MS = 6_000;

/** How long the first of an account's two addresses may take at app start before the other is used. */
export const ROUTE_TIMEOUT_MS = 3_000;

/**
 * How long an API request waits for the server to start answering before it counts as "server
 * unreachable" (offline mode). A server that is off or on another network otherwise hangs until
 * the OS gives up on the connection (a minute or more).
 */
export const CONNECT_TIMEOUT_MS = 9_000;
