import dns, { type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { isBlockedAddress, normalizeHost } from './address.js';

/** `dns.lookup` with `{ all: true }`, injectable so tests can map names without real DNS. */
export type ResolveAll = (hostname: string) => Promise<LookupAddress[]>;

export const systemResolveAll: ResolveAll = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** Which targets a request may reach. */
export interface TargetPolicy {
  /**
   * Allow loopback / LAN / link-local targets. Only for hosts an admin configured
   * (download clients, media servers, indexers the admin added). Default false.
   */
  allowPrivate?: boolean;
  /** Test seam: decide per resolved address (wins over `allowPrivate`). */
  allowAddress?: (address: string, hostname: string) => boolean;
  /** Test seam / custom resolver. Defaults to the system resolver. */
  resolve?: ResolveAll;
}

export class BlockedAddressError extends Error {
  readonly code = 'EBLOCKEDADDRESS';
  constructor(readonly hostname: string) {
    super(`${hostname} is a local or reserved network address, which this request may not reach`);
    this.name = 'BlockedAddressError';
  }
}

function allowed(policy: TargetPolicy, address: string, hostname: string): boolean {
  if (policy.allowAddress) return policy.allowAddress(address, hostname);
  return policy.allowPrivate === true || !isBlockedAddress(address);
}

/**
 * Resolve `rawHost` and vet every address it returns. Throws `BlockedAddressError` when any
 * address is not allowed (a name mixing public and private answers is refused outright, which
 * also defeats rebinding between the answers). Returns the vetted addresses.
 */
export async function resolveAllowed(rawHost: string, policy: TargetPolicy = {}): Promise<LookupAddress[]> {
  const host = normalizeHost(rawHost);
  const family = isIP(host);
  if (family) {
    if (!allowed(policy, host, host)) throw new BlockedAddressError(host);
    return [{ address: host, family }];
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (!allowed(policy, '127.0.0.1', host)) throw new BlockedAddressError(host);
  }
  const answers = await (policy.resolve ?? systemResolveAll)(host);
  if (answers.length === 0) throw Object.assign(new Error(`${host} did not resolve`), { code: 'ENOTFOUND' });
  for (const a of answers) if (!allowed(policy, a.address, host)) throw new BlockedAddressError(host);
  return answers;
}

/** Throws `BlockedAddressError` when the URL's host is (or resolves to) a disallowed address. */
export async function assertAllowedUrl(url: string | URL, policy: TargetPolicy = {}): Promise<void> {
  const u = typeof url === 'string' ? new URL(url) : url;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedAddressError(u.protocol);
  await resolveAllowed(u.hostname, policy);
}

/**
 * A `lookup` for `net.connect` / `http.request` that only hands out vetted addresses, so the
 * socket connects to exactly the address that was checked (no gap for DNS rebinding). Node
 * skips `lookup` for IP-literal hosts, so check those with `resolveAllowed` before the request.
 */
export function guardedLookup(policy: TargetPolicy = {}): LookupFunction {
  return (hostname, options, callback) => {
    resolveAllowed(hostname, policy).then(
      (answers) => {
        const want = typeof options === 'object' && options ? options.family : undefined;
        const fam = want === 4 || want === 6 ? answers.filter((a) => a.family === want) : answers;
        const list = fam.length > 0 ? fam : answers;
        if (typeof options === 'object' && options && options.all) {
          (callback as (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, list);
        } else {
          const first = list[0]!;
          callback(null, first.address, first.family);
        }
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 0),
    );
  };
}
