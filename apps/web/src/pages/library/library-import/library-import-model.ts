import type {
  LibraryImportCandidate,
  LibraryImportMatch,
  LibraryImportMode,
  LibraryImportRequestInput,
  LibraryImportScan,
  LibraryImportScanStatus,
} from '@arclight/shared';
import { t } from '../../../i18n/index.js';

// Pure helpers of the library import page: which candidates are chosen, the match each one
// imports with (the proposal unless the user picked another or none), filtering and the request.

/** Proposals at or above this are selected when a scan finishes. */
export const AUTO_SELECT_CONFIDENCE = 0.6;

export function isScanActive(status: LibraryImportScanStatus): boolean {
  return status === 'scanning' || status === 'matching' || status === 'importing';
}

/** The user's match choices by candidate id: a match, or null for "no match". */
export type MatchOverrides = ReadonlyMap<string, LibraryImportMatch | null>;

export function effectiveMatch(c: LibraryImportCandidate, overrides: MatchOverrides): LibraryImportMatch | null {
  return overrides.has(c.id) ? (overrides.get(c.id) ?? null) : c.match;
}

/** Can be imported: not done yet and with a match. */
export function importable(c: LibraryImportCandidate, overrides: MatchOverrides): boolean {
  return c.status !== 'imported' && c.status !== 'importing' && effectiveMatch(c, overrides) !== null;
}

/** Confident proposals that still wait for an import. */
export function defaultSelection(candidates: readonly LibraryImportCandidate[]): Set<string> {
  return new Set(candidates.filter((c) => c.status === 'pending' && c.match !== null && c.confidence >= AUTO_SELECT_CONFIDENCE).map((c) => c.id));
}

export type CandidateFilter = 'all' | 'matched' | 'unmatched' | 'warnings' | 'imported' | 'failed';

export function filterCandidates(list: readonly LibraryImportCandidate[], filter: CandidateFilter, search: string, overrides: MatchOverrides): LibraryImportCandidate[] {
  const q = search.trim().toLowerCase();
  return list.filter((c) => {
    const match = effectiveMatch(c, overrides);
    if (filter === 'matched' && (match === null || c.status === 'imported')) return false;
    if (filter === 'unmatched' && match !== null) return false;
    if (filter === 'warnings' && c.warnings.length === 0) return false;
    if (filter === 'imported' && c.status !== 'imported') return false;
    if (filter === 'failed' && c.status !== 'failed') return false;
    if (!q) return true;
    return [c.relativeFolder, c.detected.author, c.detected.title, match?.title, match?.creditName].some((v) => v?.toLowerCase().includes(q));
  });
}

/** Selected candidates that can be imported, in list order. */
export function selectedImportable(list: readonly LibraryImportCandidate[], selected: ReadonlySet<string>, overrides: MatchOverrides): LibraryImportCandidate[] {
  return list.filter((c) => selected.has(c.id) && importable(c, overrides));
}

export function toImportRequest(
  scan: Pick<LibraryImportScan, 'id' | 'candidates'>,
  selected: ReadonlySet<string>,
  overrides: MatchOverrides,
  opts: { qualityProfileId: number; mode: LibraryImportMode },
): LibraryImportRequestInput {
  return {
    scanId: scan.id,
    items: selectedImportable(scan.candidates, selected, overrides).map((c) => {
      const match = effectiveMatch(c, overrides)!;
      return match.foreignId === c.match?.foreignId ? { candidateId: c.id } : { candidateId: c.id, foreignId: match.foreignId };
    }),
    mode: opts.mode,
    qualityProfileId: opts.qualityProfileId,
  };
}

/** What the scan is doing, for the progress line. */
export function progressText(scan: Pick<LibraryImportScan, 'status' | 'progress' | 'mediaType'>): string {
  const { done, total } = scan.progress;
  switch (scan.status) {
    case 'scanning':
      return total > 0 ? t('libraryImport.progress.reading', { done, total }) : t('libraryImport.progress.walking');
    case 'matching':
      return t('libraryImport.progress.matching', { done, total });
    case 'importing':
      return t('libraryImport.progress.importing', { done, total });
    default:
      return '';
  }
}

export function progressPercent(scan: Pick<LibraryImportScan, 'progress'>): number {
  const { done, total } = scan.progress;
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
}

/** The search box's first text for a candidate: what was detected, else the folder name. */
export function searchTermFor(c: Pick<LibraryImportCandidate, 'detected' | 'relativeFolder'>): string {
  const parts = [c.detected.author, c.detected.title].filter((p): p is string => !!p);
  if (parts.length > 0) return parts.join(' ');
  const last = c.relativeFolder.split(/[\\/]/).filter(Boolean).pop();
  return last && last !== '.' ? last : '';
}

/** "Author – Title (Year)" of a match. */
export function matchLabel(m: Pick<LibraryImportMatch, 'title' | 'creditName' | 'year'>): string {
  const title = m.year ? `${m.title} (${m.year})` : m.title;
  return m.creditName ? `${m.creditName} – ${title}` : title;
}
