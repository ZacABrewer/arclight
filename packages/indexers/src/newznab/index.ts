import { fetchCapsFor, searchFor } from '../newznab-common/index.js';
import type {
  ClientOptions,
  IndexerCapabilities,
  IndexerDefinition,
  ReleaseInfo,
  SearchRequest,
} from '../types.js';

/** Newznab usenet indexers: NZB enclosures, `usenetdate`, `grabs`. */
export function fetchCaps(def: IndexerDefinition, options: ClientOptions = {}): Promise<IndexerCapabilities> {
  return fetchCapsFor(def, options);
}

export function search(
  def: IndexerDefinition,
  request: SearchRequest,
  caps: IndexerCapabilities,
  options: ClientOptions = {},
): Promise<ReleaseInfo[]> {
  return searchFor('newznab', { ...def, protocol: 'usenet' }, request, caps, options);
}
