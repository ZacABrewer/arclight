/** A plain network egress proxy (S14.1 http / socks5). */
export interface NetworkProxy {
  type: 'http' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** A FlareSolverr challenge solver (S14.4). */
export interface FlareSolverrConfig {
  type: 'flaresolverr';
  /** Base URL, e.g. http://localhost:8191 (trailing slash trimmed; requests go to `{url}/v1`). */
  url: string;
  /** `maxTimeout` sent to FlareSolverr, default 60_000; the HTTP timeout is this + 5000. */
  timeoutMs?: number;
  /** Default false. When true, one session is created lazily and reused for every solve. */
  useSession?: boolean;
  /** Sent as `X-Api-Key` on every call (Arclight's built-in solver endpoint needs it; FlareSolverr ignores it). */
  apiKey?: string;
}

export type ProxyConfig = NetworkProxy | FlareSolverrConfig;

export function isNetworkProxy(proxy: ProxyConfig): proxy is NetworkProxy {
  return proxy.type === 'http' || proxy.type === 'socks5';
}

export function isFlareSolverr(proxy: ProxyConfig): proxy is FlareSolverrConfig {
  return proxy.type === 'flaresolverr';
}
