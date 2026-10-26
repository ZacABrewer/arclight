import { fetchCapsFor, searchFor } from '../newznab-common/index.js';
import type {
  ClientOptions,
  IndexerCapabilities,
  IndexerDefinition,
  ReleaseInfo,
  SearchRequest,
} from '../types.js';

/** Torznab is Newznab plus torrent attrs (seeders, peers, infohash, magneturl, volume factors). */
export function fetchCaps(def: IndexerDefinition, options: ClientOptions = {}): Promise<IndexerCapabilities> {
  return fetchCapsFor(def, options);
}

export function search(
  def: IndexerDefinition,
  request: SearchRequest,
  caps: IndexerCapabilities,
  options: ClientOptions = {},
): Promise<ReleaseInfo[]> {
  return searchFor('torznab', { ...def, protocol: 'torrent' }, request, caps, options);
}
