import { isMetadataError } from '@media-tron/metadata';
import { LibraryError, type MetadataLookup } from '../library/index.js';
import { MetadataNotConfiguredError, type MetadataService } from './service.js';

/**
 * Adapter the library module calls when a title is added by tmdbId. Metadata failures the
 * user can fix (no key, rejected key) become library validation errors (HTTP 400) so the
 * add screen shows a clear message; "not found" becomes null (HTTP 404); anything else
 * propagates as an internal error.
 */
export function createMetadataLookup(getService: () => MetadataService | null): MetadataLookup {
  const run = async <T>(fn: (service: MetadataService) => Promise<T>): Promise<T> => {
    const service = getService();
    if (!service) throw new LibraryError('VALIDATION', 'metadata module is not registered');
    try {
      return await fn(service);
    } catch (err) {
      if (err instanceof MetadataNotConfiguredError) throw new LibraryError('VALIDATION', err.message);
      if (isMetadataError(err, 'unauthorized')) {
        throw new LibraryError('VALIDATION', 'TMDB rejected the configured API key');
      }
      throw err;
    }
  };
  return {
    series: (tmdbId) => run((s) => s.lookupSeries(tmdbId)),
    movie: (tmdbId) => run((s) => s.lookupMovie(tmdbId)),
  };
}
