import { INDEXER_PRIORITY_MAX, INDEXER_PRIORITY_MIN, type IndexerImplementation, type IndexerSettingsInput } from '@arclight/shared';
import { field, int, num, str } from '../foreign-db.js';

// Torznab/Newznab indexer settings (Sonarr, Radarr and Prowlarr store the same field names).
// Seed times upstream are minutes; Arclight stores milliseconds.

const MINUTE = 60_000;

export function indexerImplementation(upstream: string): IndexerImplementation | null {
  const s = upstream.toLowerCase();
  if (s === 'torznab') return 'torznab';
  if (s === 'newznab') return 'newznab';
  return null;
}

function categoryList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => int(x)).filter((x): x is number => x !== null && x >= 0);
}

export function mapIndexerSettings(settings: Record<string, unknown>): IndexerSettingsInput {
  const seed = field(settings, 'seedCriteria');
  const sc = seed && typeof seed === 'object' ? (seed as Record<string, unknown>) : {};
  const minutes = (v: unknown) => {
    const n = num(v);
    return n !== null && n >= 0 ? Math.round(n * MINUTE) : undefined;
  };
  const out: IndexerSettingsInput = {
    baseUrl: (str(field(settings, 'baseUrl')) ?? '').trim(),
    apiPath: str(field(settings, 'apiPath')) ?? '/api',
    categories: categoryList(field(settings, 'categories')),
    animeCategories: categoryList(field(settings, 'animeCategories')),
  };
  const apiKey = str(field(settings, 'apiKey'));
  if (apiKey) out.apiKey = apiKey;
  const seeders = int(field(settings, 'minimumSeeders'));
  if (seeders !== null && seeders >= 0) out.minimumSeeders = seeders;
  const ratio = num(field(sc, 'seedRatio') ?? field(settings, 'seedRatio'));
  if (ratio !== null && ratio >= 0) out.seedRatio = ratio;
  const seedTime = minutes(field(sc, 'seedTime') ?? field(settings, 'seedTime'));
  if (seedTime !== undefined) out.seedTime = seedTime;
  const packTime = minutes(field(sc, 'seasonPackSeedTime'));
  if (packTime !== undefined) out.seasonPackSeedTime = packTime;
  const extra = str(field(settings, 'additionalParameters'));
  if (extra) out.additionalParameters = extra;
  return out;
}

export function clampPriority(v: unknown): number {
  const n = int(v) ?? 25;
  return Math.min(INDEXER_PRIORITY_MAX, Math.max(INDEXER_PRIORITY_MIN, n));
}

/** Prowlarr native/Cardigann indexers that serve usenet (everything else is torrent). */
const USENET_HINTS = /newznab|nzb|usenet|binsearch|omgwtf|drunkenslug|ninjacentral|dognzb|althub|tabula/i;

export function prowlarrProtocolGuess(implementation: string, definition: string | null): 'torznab' | 'newznab' {
  return USENET_HINTS.test(implementation) || (definition !== null && USENET_HINTS.test(definition)) ? 'newznab' : 'torznab';
}

/** `http://host:port/urlbase` for a Prowlarr instance from its config.xml values. */
export function prowlarrBaseUrl(config: Record<string, string>): string {
  const port = config['port'] ?? '9696';
  const bind = config['bindaddress'];
  const host = !bind || bind === '*' || bind === '0.0.0.0' ? 'localhost' : bind;
  const ssl = (config['enablessl'] ?? '').toLowerCase() === 'true';
  const urlBase = (config['urlbase'] ?? '').replace(/\/+$/, '');
  const scheme = ssl ? 'https' : 'http';
  const p = ssl ? (config['sslport'] ?? port) : port;
  return `${scheme}://${host}:${p}${urlBase ? (urlBase.startsWith('/') ? urlBase : `/${urlBase}`) : ''}`;
}
