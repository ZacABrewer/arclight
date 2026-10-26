import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { MetadataSearchType } from '@arclight/shared';
import { isMissingTmdbKey, metadataApi } from '../api/metadata.js';
import { libraryKeys } from './library-keys.js';

/** Returns `value` once it has stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** TMDB lookup for the add-new screen. Idle until the term has at least two characters. */
export function useMetadataSearch(term: string, type: MetadataSearchType = 'all') {
  const query = term.trim();
  return useQuery({
    queryKey: libraryKeys.metadata.search(query, type),
    queryFn: () => metadataApi.search(query, type),
    enabled: query.length >= 2,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    // A missing key will not fix itself on retry.
    retry: (count, err) => !isMissingTmdbKey(err) && count < 1,
  });
}
