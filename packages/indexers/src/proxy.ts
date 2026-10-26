/**
 * Indexer proxies (spec indexer-definitions S14): HTTP CONNECT / SOCKS5 tunnelling and the
 * FlareSolverr challenge solver, composed into a fetch-compatible function.
 */
export type { NetworkProxy, FlareSolverrConfig, ProxyConfig } from './proxy/types.js';
export { isNetworkProxy, isFlareSolverr } from './proxy/types.js';
export { ProxyError } from './proxy/errors.js';
export type { ProxyErrorCode } from './proxy/errors.js';
export { openSocks5Tunnel, openHttpConnectTunnel, DEFAULT_TUNNEL_TIMEOUT_MS } from './proxy/tunnel.js';
export { fetchWithProxy, DEFAULT_FETCH_TIMEOUT_MS } from './proxy/http-client.js';
export {
  FlareSolverrClient,
  isChallengeResponse,
  CHALLENGE_MARKERS,
  CHALLENGE_SERVERS,
  DEFAULT_FLARESOLVERR_TIMEOUT_MS,
  DEFAULT_FLARESOLVERR_TEST_URL,
} from './proxy/flaresolverr.js';
export type { FlareSolverrSolution, FlareSolverrCookie, FlareSolverrClientOptions } from './proxy/flaresolverr.js';
export { createProxiedFetch } from './proxy/proxied-fetch.js';
export type { ProxiedFetchOptions } from './proxy/proxied-fetch.js';
