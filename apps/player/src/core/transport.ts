import { classifyHost, type HostClass } from './address';
import { memoryStore, readJson, writeJson, type KeyValueStore } from './kv';

// The cleartext policy: which server addresses may carry a sign-in, a pair code or the device
// token. Android and iOS allow plain http at the platform level (self-hosted servers on a home
// network rarely have certificates), so the rule lives here, in the API client:
//
//  - https:// is always fine.
//  - http:// to the home network (core/address.ts classifyHost: private or loopback) is fine; the
//    screens show a one-time notice per host that the traffic is not encrypted.
//  - http:// to a host on the internet needs the user to type that host name once; the answer is
//    kept per host. The app tries https:// first everywhere and keeps it when it works.
//  - A host pinned to https (an Arclight server answered there) is never used over http again
//    without that same typed confirmation, even on the home network.
//
// Records are per host name (no port): "music.example.com" pinned to https also covers
// http://music.example.com:7878.

export type Transport = 'https' | 'http-private' | 'http-public';

/** What has to happen before credentials go to a URL: nothing, the LAN notice, or the typed confirmation. */
export type TransportNeed = 'none' | 'notice' | 'confirm';

interface HostRecord {
  /** An Arclight server answered over https on this host. */
  https?: true;
  /** The user typed the host name to allow plain http. */
  httpConfirmed?: true;
  /** The user saw the "not encrypted on your network" notice for this host. */
  httpNoticed?: true;
}

interface StoredPolicy {
  version: 1;
  hosts: Record<string, HostRecord>;
}

const KEY = 'arclight.transport';

function parse(url: string): { protocol: string; hostname: string } | null {
  try {
    const u = new URL(url);
    return { protocol: u.protocol, hostname: u.hostname.toLowerCase().replace(/^\[|\]$/g, '') };
  } catch {
    return null;
  }
}

/** The host name the user types to confirm ("music.example.com", "203.0.113.7"). */
export function confirmationName(url: string): string {
  return parse(url)?.hostname ?? '';
}

/** Does what the user typed name this URL's host? Case, surrounding spaces and a trailing dot do not matter. */
export function confirmationMatches(url: string, typed: string): boolean {
  const want = confirmationName(url);
  return !!want && typed.trim().toLowerCase().replace(/\.$/, '') === want;
}

export function hostClassOf(url: string): HostClass {
  const p = parse(url);
  return p ? classifyHost(p.hostname) : 'public';
}

export function transportOf(url: string): Transport {
  const p = parse(url);
  if (p?.protocol === 'https:') return 'https';
  return hostClassOf(url) === 'public' ? 'http-public' : 'http-private';
}

export class TransportPolicy {
  private hosts: Record<string, HostRecord> = {};

  constructor(private kv: KeyValueStore = memoryStore()) {}

  /** Reads the saved records (once, at start). `kv` replaces the store (tests). */
  async load(kv?: KeyValueStore): Promise<void> {
    if (kv) this.kv = kv;
    const stored = await readJson<StoredPolicy>(this.kv, KEY);
    this.hosts = stored && typeof stored.hosts === 'object' && stored.hosts ? { ...stored.hosts } : {};
  }

  private record(url: string): HostRecord {
    const host = parse(url)?.hostname;
    return (host && this.hosts[host]) || {};
  }

  private async update(url: string, change: (r: HostRecord) => HostRecord): Promise<void> {
    const host = parse(url)?.hostname;
    if (!host) return;
    this.hosts = { ...this.hosts, [host]: change({ ...(this.hosts[host] ?? {}) }) };
    await writeJson(this.kv, KEY, { version: 1, hosts: this.hosts } satisfies StoredPolicy);
  }

  /** This host answered as Arclight over https before. */
  isPinnedHttps(url: string): boolean {
    return this.record(url).https === true;
  }

  /** May a sign-in, pair code or device token be sent to `url`? */
  allowsCredentials(url: string): boolean {
    const r = this.record(url);
    switch (transportOf(url)) {
      case 'https':
        return true;
      case 'http-private':
        return !r.https || r.httpConfirmed === true;
      case 'http-public':
        return r.httpConfirmed === true;
    }
  }

  /** What the screens show before using `url`. */
  need(url: string): TransportNeed {
    if (transportOf(url) === 'https') return 'none';
    if (!this.allowsCredentials(url)) return 'confirm';
    return this.record(url).httpNoticed || this.record(url).httpConfirmed ? 'none' : 'notice';
  }

  /** The user typed the host name: plain http to it is allowed from now on. */
  confirm(url: string): Promise<void> {
    return this.update(url, (r) => ({ ...r, httpConfirmed: true, httpNoticed: true }));
  }

  /** The user saw the home-network notice for this host. */
  noticed(url: string): Promise<void> {
    if (this.record(url).httpNoticed) return Promise.resolve();
    return this.update(url, (r) => ({ ...r, httpNoticed: true }));
  }

  /**
   * An Arclight server answered over https on this host: pin it. The first pin drops an earlier
   * http confirmation, so going back to http asks again.
   */
  pinHttps(url: string): Promise<void> {
    if (transportOf(url) !== 'https' || this.isPinnedHttps(url)) return Promise.resolve();
    return this.update(url, (r) => {
      const { httpConfirmed: _dropped, ...rest } = r;
      return { ...rest, https: true };
    });
  }
}

/** The app's policy; createServices loads it from Preferences before the first request. */
export const transportPolicy = new TransportPolicy();
