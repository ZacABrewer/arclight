export {
  AUDIBLE_DEFAULT_CACHE_TTLS,
  AUDIBLE_PROVIDER,
  AUDIBLE_RESPONSE_GROUPS,
  createAudibleClient,
  type AudibleAuthorRef,
  type AudibleBibliographyOptions,
  type AudibleCacheTtls,
  type AudibleCatalogClient,
  type AudibleClientOptions,
  type AudibleSearchOptions,
  type AudibleSearchQuery,
  type AudibleSort,
} from './client.js';
export { isAudiobookProduct, isTranslatorCredit } from './map.js';
export {
  AUDIBLE_REGIONS,
  AUDIBLE_REGION_TLDS,
  DEFAULT_AUDIBLE_REGION,
  audibleApiBaseUrl,
  isAsin,
  isAudibleRegion,
  normalizeAsin,
  requireAudibleRegion,
  type AudibleRegion,
} from './regions.js';
export type { AudiblePage, AudiblePersonRef, AudibleProduct, AudibleSeriesRef } from './types.js';
