import {
  ALL_QUALITIES,
  qualityById,
  type ImportRejection,
  type ManualImportItem,
  type ManualImportRequestInput,
  type MediaType,
  type QualityModel,
  type QueueItem,
} from '@arclight/shared';
import { t } from '../../../i18n/index.js';

// Manual import wizard state: one row per candidate file with the user's mapping. Pure so the
// mapping rules are unit-tested without rendering.

export interface ImportRow {
  path: string;
  relativePath: string;
  name: string;
  sizeBytes: number;
  selected: boolean;
  mediaType: MediaType;
  seriesId: number | null;
  seasonNumber: number | null;
  episodeIds: number[];
  movieId: number | null;
  quality: QualityModel;
  languages: string[];
  releaseGroup: string;
  rejections: ImportRejection[];
  downloadId: string | undefined;
  /** Multi-version items: the version slot to fill; '' = best fit (chosen by the server). */
  versionTag: string;
}

export type RowAction =
  | { type: 'toggle'; path: string; selected: boolean }
  | { type: 'toggleAll'; selected: boolean }
  | { type: 'mediaType'; path: string; mediaType: MediaType }
  | { type: 'series'; path: string; seriesId: number | null }
  | { type: 'season'; path: string; seasonNumber: number | null }
  | { type: 'episodes'; path: string; episodeIds: number[] }
  | { type: 'movie'; path: string; movieId: number | null }
  | { type: 'quality'; path: string; qualityId: number }
  | { type: 'languages'; path: string; languages: string[] }
  | { type: 'releaseGroup'; path: string; releaseGroup: string }
  | { type: 'version'; path: string; versionTag: string }
  | { type: 'reset'; rows: ImportRow[] };

/** Rejections that mean the file is not a candidate at all (not a mapping problem). */
const UNMAPPABLE = new Set(['dangerousFile', 'executableFile', 'archiveFile', 'sample', 'alreadyImported', 'sameFile']);

export function toRow(item: ManualImportItem, fallbackType: MediaType = 'series'): ImportRow {
  const mediaType: MediaType = item.mediaType ?? (item.movieId !== undefined ? 'movie' : fallbackType);
  const row: ImportRow = {
    path: item.path,
    relativePath: item.relativePath,
    name: item.name,
    sizeBytes: item.sizeBytes,
    selected: false,
    mediaType,
    seriesId: item.seriesId ?? null,
    seasonNumber: item.seasonNumber ?? null,
    episodeIds: item.episodeIds ?? [],
    movieId: item.movieId ?? null,
    quality: item.quality,
    languages: item.languages,
    releaseGroup: item.releaseGroup ?? '',
    rejections: item.rejections,
    downloadId: item.downloadId,
    versionTag: '',
  };
  // Pre-select files that are fully mapped and not rejected for a reason mapping cannot fix.
  row.selected = rowProblems(row).length === 0 && !item.rejections.some((r) => UNMAPPABLE.has(r.reason));
  return row;
}

export function initRows(items: readonly ManualImportItem[], fallbackType: MediaType = 'series'): ImportRow[] {
  return items.map((i) => toRow(i, fallbackType));
}

/** What still has to be chosen before the row can be imported. */
export function rowProblems(row: ImportRow): string[] {
  const out: string[] = [];
  if (row.mediaType === 'series') {
    if (row.seriesId === null) out.push(t('activity.manualImport.mapping.chooseASeries'));
    else if (row.seasonNumber === null) out.push(t('activity.manualImport.mapping.chooseASeason'));
    else if (row.episodeIds.length === 0) out.push(t('activity.manualImport.mapping.chooseEpisodes'));
  } else if (row.movieId === null) {
    out.push(t('activity.manualImport.mapping.chooseAMovie'));
  }
  return out;
}

function update(rows: ImportRow[], path: string, fn: (r: ImportRow) => ImportRow): ImportRow[] {
  return rows.map((r) => (r.path === path ? fn(r) : r));
}

/** Any mapping edit selects the row once it becomes complete (the user clearly wants it). */
function remap(r: ImportRow, patch: Partial<ImportRow>): ImportRow {
  const next = { ...r, ...patch };
  if (rowProblems(next).length === 0 && rowProblems(r).length > 0) next.selected = true;
  if (rowProblems(next).length > 0) next.selected = false;
  return next;
}

export function rowsReducer(rows: ImportRow[], action: RowAction): ImportRow[] {
  switch (action.type) {
    case 'reset':
      return action.rows;
    case 'toggle':
      return update(rows, action.path, (r) => ({ ...r, selected: action.selected && rowProblems(r).length === 0 }));
    case 'toggleAll':
      return rows.map((r) => ({ ...r, selected: action.selected && rowProblems(r).length === 0 }));
    case 'mediaType':
      return update(rows, action.path, (r) =>
        r.mediaType === action.mediaType ? r : remap(r, { mediaType: action.mediaType, seriesId: null, seasonNumber: null, episodeIds: [], movieId: null, versionTag: '' }),
      );
    case 'series':
      // A different series invalidates the season, episodes and version slot.
      return update(rows, action.path, (r) =>
        r.seriesId === action.seriesId ? r : remap(r, { seriesId: action.seriesId, seasonNumber: null, episodeIds: [], versionTag: '' }),
      );
    case 'season':
      return update(rows, action.path, (r) => (r.seasonNumber === action.seasonNumber ? r : remap(r, { seasonNumber: action.seasonNumber, episodeIds: [] })));
    case 'episodes':
      return update(rows, action.path, (r) => remap(r, { episodeIds: [...new Set(action.episodeIds)] }));
    case 'movie':
      return update(rows, action.path, (r) => (r.movieId === action.movieId ? r : remap(r, { movieId: action.movieId, versionTag: '' })));
    case 'version':
      return update(rows, action.path, (r) => ({ ...r, versionTag: action.versionTag }));
    case 'quality':
      return update(rows, action.path, (r) => ({ ...r, quality: { ...r.quality, quality: toQualityModelDefinition(action.qualityId) } }));
    case 'languages':
      return update(rows, action.path, (r) => ({ ...r, languages: action.languages }));
    case 'releaseGroup':
      return update(rows, action.path, (r) => ({ ...r, releaseGroup: action.releaseGroup }));
  }
}

/** The contract's (mutable) quality definition for an id. */
function toQualityModelDefinition(id: number): QualityModel['quality'] {
  const q = qualityById(id);
  return { ...q, mediaTypes: [...q.mediaTypes] };
}

/** Qualities offered for a row's media type, best first. */
export function qualityOptions(mediaType: MediaType) {
  return ALL_QUALITIES.filter((q) => q.mediaTypes.includes(mediaType)).sort((a, b) => b.weight - a.weight);
}

/** `English, French` -> ['English', 'French']. */
export function parseLanguages(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The POST /manualimport body for the selected, complete rows. */
export function toImportRequest(rows: readonly ImportRow[], importMode: 'move' | 'copy' | 'auto'): ManualImportRequestInput {
  const items = rows
    .filter((r) => r.selected && rowProblems(r).length === 0)
    .map((r) => ({
      path: r.path,
      mediaType: r.mediaType,
      ...(r.mediaType === 'series'
        ? { seriesId: r.seriesId!, seasonNumber: r.seasonNumber!, episodeIds: r.episodeIds }
        : { movieId: r.movieId! }),
      quality: r.quality,
      languages: r.languages,
      releaseGroup: r.releaseGroup.trim() === '' ? null : r.releaseGroup.trim(),
      ...(r.downloadId ? { downloadId: r.downloadId } : {}),
      ...(r.versionTag ? { versionTag: r.versionTag } : {}),
    }));
  return { items, importMode };
}

/** Version slots of the row's chosen series or movie (empty for unversioned items). */
export function rowVersionTags(
  row: Pick<ImportRow, 'mediaType' | 'seriesId' | 'movieId'>,
  seriesList: ReadonlyArray<{ id: number; versions?: ReadonlyArray<{ tag: string }> | null | undefined }>,
  movieList: ReadonlyArray<{ id: number; versions?: ReadonlyArray<{ tag: string }> | null | undefined }>,
): string[] {
  const owner = row.mediaType === 'series' ? seriesList.find((s) => s.id === row.seriesId) : movieList.find((m) => m.id === row.movieId);
  return (owner?.versions ?? []).map((v) => v.tag);
}

export function selectedCount(rows: readonly ImportRow[]): number {
  return rows.filter((r) => r.selected).length;
}

/** Queue rows a manual import can help with: stuck in import, or finished with warnings/errors. */
export function needsManualImport(q: Pick<QueueItem, 'trackedState' | 'trackedStatus' | 'outputPath' | 'progress'>): boolean {
  if (q.trackedState === 'importPending' || q.trackedState === 'failedPending') return true;
  return q.trackedStatus !== 'ok' && q.outputPath !== undefined && q.progress >= 1;
}
