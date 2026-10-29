export {
  createAudiobookCatalog,
  createDefaultAudiobookCatalog,
  type AudiobookCatalog,
  type AudiobookCatalogDeps,
  type CatalogAuthorRef,
  type CatalogBookQuery,
  type CatalogBookRef,
  type CatalogBrowseSort,
  type CatalogRequestOptions,
  type CatalogSearchOptions,
  type DefaultAudiobookCatalogOptions,
} from './catalog.js';
export { dedupeAuthors, dedupeBooks, groupSeries, mergeBooks, titleAuthorKey } from './map.js';
export type {
  CatalogAuthor,
  CatalogAuthorWithBooks,
  CatalogBook,
  CatalogChapters,
  CatalogImages,
  CatalogPersonRef,
  CatalogSeries,
  CatalogSeriesEntry,
  CatalogSeriesRef,
  CatalogSource,
} from './types.js';
