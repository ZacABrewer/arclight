/**
 * Address policy for the engine's outbound traffic whose target a remote party picks: tracker
 * announces and web seeds (the .torrent or magnet names them), and peer / DHT node addresses
 * (trackers, the DHT and PEX hand them out). By default none of them may point at loopback,
 * the LAN or other non-public ranges, so a crafted torrent or a hostile peer cannot make the
 * engine probe the local network. `allowLocalTrackers` / `allowLocalPeers` lift that for
 * people who run a LAN tracker or LAN peers.
 */
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { guardedLookup, isBlockedAddress, isPrivateHostname, normalizeHost, resolveAllowed } from '@arclight/net';

export { isBlockedAddress };

/** True when `host` (an IP literal) is not a public unicast address. */
export function isLocalAddress(host: string): boolean {
  return isBlockedAddress(host);
}

/** True for URLs whose host is a LAN-style name or a non-public IP literal (no DNS). */
export function isLocalUrlHost(url: string): boolean {
  try {
    return isPrivateHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Vets one HTTP hop. With `allowPrivate` nothing is checked (the old behaviour). Otherwise an IP
 * literal host is checked here (Node skips `lookup` for literals) and a name gets a `lookup`
 * that only hands out public addresses, so the socket connects to exactly the vetted address.
 * Rejects with `BlockedAddressError` for a refused target.
 */
export async function guardHop(url: URL, allowPrivate: boolean): Promise<{ lookup?: LookupFunction }> {
  if (allowPrivate) return {};
  const host = normalizeHost(url.hostname);
  if (isIP(host) || host === 'localhost' || host.endsWith('.localhost')) {
    await resolveAllowed(host);
    return {};
  }
  return { lookup: guardedLookup() };
}
