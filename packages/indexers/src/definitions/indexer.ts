/**
 * `createDefinitionIndexer`: wraps a YAML site definition in the same `Indexer` interface
 * the Torznab/Newznab clients expose, plus `download()` and `login()`.
 */
import type { Indexer, IndexerTestResult } from '../index.js';
import type { IndexerCapabilities, IndexerDefinition, ReleaseInfo } from '../types.js';
import { synthesizeCaps } from './categories.js';
import { parseDefinitionYaml } from './catalogue.js';
import {
  DefinitionRuntime,
  type AccountStats,
  type DefinitionSearchRequest,
  type DownloadResult,
  type RuntimeOptions,
  type SettingsValues,
} from './runtime.js';
import type { Definition } from './schema.js';

export interface DefinitionIndexer extends Indexer {
  /** The parsed site definition. */
  readonly site: Definition;
  readonly runtime: DefinitionRuntime;
  search(request: DefinitionSearchRequest): Promise<ReleaseInfo[]>;
  /** Resolve a release link to torrent bytes or a magnet (S11). */
  download(url: string): Promise<DownloadResult>;
  /** Force a login now (normally lazy). */
  login(): Promise<void>;
  /** Account statistics from the definition's `account` page (Arclight extension). */
  accountStats(): Promise<AccountStats>;
}

export interface DefinitionIndexerOptions extends RuntimeOptions {
  /** Display name override (defaults to the definition name). */
  name?: string;
}

export function createDefinitionIndexer(
  def: Definition | string,
  settingsValues: SettingsValues = {},
  options: DefinitionIndexerOptions = {},
): DefinitionIndexer {
  const site = typeof def === 'string' ? parseDefinitionYaml(def) : def;
  const runtime = new DefinitionRuntime(site, settingsValues, options);
  const caps = synthesizeCaps(site, runtime.categoryMap);
  const definition: IndexerDefinition = {
    name: options.name ?? site.name,
    baseUrl: runtime.siteLink,
    categories: caps.categories.map((c) => c.id),
    protocol: 'torrent',
    ...(options.rateLimitMs === undefined && site.requestdelay === undefined
      ? {}
      : { rateLimitMs: Math.max(options.rateLimitMs ?? 0, (site.requestdelay ?? 0) * 1000) }),
    ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
  };
  const getCaps = async (): Promise<IndexerCapabilities> => caps;

  return {
    definition,
    site,
    runtime,
    caps: getCaps,
    rss: () => runtime.search({ kind: 'rss' }),
    search: (request) => runtime.search(request),
    download: (url) => runtime.download(url),
    login: () => runtime.login(),
    accountStats: () => runtime.accountStats(),
    async test(): Promise<IndexerTestResult> {
      const result = await runtime.test();
      return result.ok ? { ok: true, caps, releaseCount: result.releaseCount } : result;
    },
  };
}
