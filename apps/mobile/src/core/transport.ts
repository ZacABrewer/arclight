import { KEYS } from '../config.js';
import { isIPv4, isIPv6, isPrivateHost } from './address.js';
import { readJson, writeJson, type KeyValueStore } from './kv.js';

// When the app may open a server over plain http.
//
//  - https:// is always fine.
//  - http:// to the phone itself (loopback) is fine: the traffic never leaves the device.
//  - http:// to a private host (home network, VPN overlay) needs a one-time notice per server
//    origin: "traffic on your network is not encrypted".
//  - http:// to a public host needs an explicit confirmation, typed by the user (the host name),
//    recorded per origin. The app tries https:// first wherever it can.
//  - Once a host has worked over https, it is pinned: an http:// address for that host later needs
//    the typed confirmation too, so nothing is downgraded silently.
//
// Only origins that pass this policy are handed to the native layer (ArclightNativePlugin), so
// only they load inside the WebView and get the native shell (CLI-01/06/07). Anything else opens
// in the system browser, if at all.

export type HostClass = 'loopback' | 'private' | 'public';

/** What has to happen before `url` may be opened. */
export type Verdict =
  | { kind: 'ok' }
  /** http:// on the home network, not acknowledged yet. */
  | { kind: 'notice'; host: string }
  /** http:// to a public host (or a host pinned to https), not confirmed yet: type `host` to go on. */
  | { kind: 'confirm'; host: string; reason: 'public' | 'downgrade' };

interface Persisted {
  version: 1;
  /** Origin (scheme://host[:port]) -> what the user agreed to. */
  acks: Record<string, 'notice' | 'confirmed'>;
  /** Host names that have worked over https. */
  httpsHosts: string[];
}

const EMPTY: Persisted = { version: 1, acks: {}, httpsHosts: [] };

const bare = (hostname: string) => hostname.toLowerCase().replace(/^\[|\]$/g, '');

export function classifyHost(hostname: string): HostClass {
  const h = bare(hostname);
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || (isIPv4(h) && h.startsWith('127.'))) return 'loopback';
  if (isIPv6(h) && /^::ffff:127\./.test(h)) return 'loopback';
  return isPrivateHost(h) ? 'private' : 'public';
}

function parse(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Pure decision for `url` given what was recorded so far. */
export function verdictFor(url: string, state: Persisted = EMPTY): Verdict {
  const u = parse(url);
  if (!u) return { kind: 'confirm', host: url, reason: 'public' };
  if (u.protocol === 'https:') return { kind: 'ok' };
  const host = bare(u.hostname);
  const cls = classifyHost(host);
  if (cls === 'loopback') return { kind: 'ok' };
  const ack = state.acks[u.origin];
  if (state.httpsHosts.includes(host)) return ack === 'confirmed' ? { kind: 'ok' } : { kind: 'confirm', host, reason: 'downgrade' };
  if (cls === 'private') return ack ? { kind: 'ok' } : { kind: 'notice', host };
  return ack === 'confirmed' ? { kind: 'ok' } : { kind: 'confirm', host, reason: 'public' };
}

/** Does what the user typed confirm `host`? (case and surrounding spaces ignored) */
export function confirmsHost(typed: string, host: string): boolean {
  return typed.trim().toLowerCase().replace(/^\[|\]$/g, '') === bare(host);
}

/** Same address over https (default port first, then the same port), for "try https first". */
export function httpsAlternatives(url: string): string[] {
  const u = parse(url);
  if (!u || u.protocol !== 'http:') return [];
  const path = u.pathname.replace(/\/+$/, '');
  const host = u.hostname.includes(':') && !u.hostname.startsWith('[') ? `[${u.hostname}]` : u.hostname;
  const out = [`https://${host}${path}`];
  if (u.port && u.port !== '80') out.push(`https://${host}:${u.port}${path}`);
  return out;
}

export class TransportStore {
  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<Persisted> {
    const d = await readJson<Persisted>(this.kv, KEYS.transport);
    if (!d || d.version !== 1 || typeof d.acks !== 'object' || !Array.isArray(d.httpsHosts)) return { version: 1, acks: {}, httpsHosts: [] };
    return { version: 1, acks: { ...d.acks }, httpsHosts: d.httpsHosts.filter((h) => typeof h === 'string') };
  }

  async verdict(url: string): Promise<Verdict> {
    return verdictFor(url, await this.load());
  }

  /** Records that the user accepted the notice (private) or typed the confirmation (public). */
  async accept(url: string, verdict: Verdict): Promise<void> {
    const u = parse(url);
    if (!u || verdict.kind === 'ok') return;
    const d = await this.load();
    d.acks[u.origin] = verdict.kind === 'notice' ? 'notice' : 'confirmed';
    await writeJson(this.kv, KEYS.transport, d);
  }

  /** The server answered over https: pin its host to https. */
  async pinHttps(url: string): Promise<void> {
    const u = parse(url);
    if (!u || u.protocol !== 'https:') return;
    const d = await this.load();
    const host = bare(u.hostname);
    if (d.httpsHosts.includes(host)) return;
    d.httpsHosts.push(host);
    await writeJson(this.kv, KEYS.transport, d);
  }

  /** Origins of `urls` that may load in the WebView now. */
  async allowedOrigins(urls: readonly string[]): Promise<string[]> {
    const d = await this.load();
    const out = new Set<string>();
    for (const url of urls) {
      const u = parse(url);
      if (u && verdictFor(url, d).kind === 'ok') out.add(u.origin);
    }
    return [...out];
  }
}
