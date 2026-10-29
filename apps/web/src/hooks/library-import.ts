import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LibraryImportMediaType, LibraryImportRequestInput, LibraryImportScan, LibraryImportScanRequest } from '@arclight/shared';
import { libraryImportApi } from '../api/library-import.js';
import { isScanActive } from '../pages/library/library-import/library-import-model.js';
import { t } from '../i18n/index.js';

// Library import of existing folders: scans are polled while their job runs; lookups are
// snapshots kept out of the library keys.

export const libraryImportKeys = {
  all: ['libraryimport'] as const,
  list: () => ['libraryimport', 'list'] as const,
  scan: (id: string | null) => ['libraryimport', 'scan', id] as const,
  lookup: (mediaType: LibraryImportMediaType, term: string) => ['libraryImportLookup', mediaType, term] as const,
};

export function useLibraryImportScans() {
  return useQuery({ queryKey: libraryImportKeys.list(), queryFn: libraryImportApi.list, staleTime: 5_000, retry: false });
}

/** One scan, polled every second while it scans, matches or imports. */
export function useLibraryImportScan(id: string | null) {
  return useQuery({
    queryKey: libraryImportKeys.scan(id),
    queryFn: () => libraryImportApi.get(id!),
    enabled: id !== null,
    retry: false,
    refetchInterval: (query) => (query.state.data && isScanActive(query.state.data.status) ? 1_000 : false),
  });
}

export function useStartLibraryImportScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LibraryImportScanRequest) => libraryImportApi.scan(body),
    meta: { errorTitle: t('libraryImport.scanFailed') },
    onSuccess: (scan) => {
      qc.setQueryData(libraryImportKeys.scan(scan.id), scan);
      void qc.invalidateQueries({ queryKey: libraryImportKeys.list() });
    },
  });
}

export function useStartLibraryImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LibraryImportRequestInput) => libraryImportApi.import(body),
    meta: { errorTitle: t('libraryImport.importFailed') },
    onSuccess: (scan: LibraryImportScan) => qc.setQueryData(libraryImportKeys.scan(scan.id), scan),
  });
}

/** Catalogue / MusicBrainz search for the match picker. Runs only for a non-empty term. */
export function useLibraryImportLookup(mediaType: LibraryImportMediaType, term: string) {
  return useQuery({
    queryKey: libraryImportKeys.lookup(mediaType, term),
    queryFn: () => libraryImportApi.lookup(mediaType, term),
    enabled: term.trim().length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
