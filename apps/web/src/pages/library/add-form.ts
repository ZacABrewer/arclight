import type { MetadataSearchResult } from '@arclight/shared';
import type {
  AddMovieRequest,
  AddSeriesRequest,
  MinimumAvailability,
  MonitorOption,
  QualityProfile,
  RootFolder,
  SeriesType,
} from '@arclight/shared';
import { t } from '../../i18n/index.js';

// Add-new dialog state, validation and request mapping. Kept pure so it is unit-tested
// without rendering.

export interface AddFormState {
  rootFolderPath: string;
  qualityProfileId: number | null;
  /** Series only. */
  monitorOption: MonitorOption;
  seriesType: SeriesType;
  seasonFolder: boolean;
  /** Movies only. */
  monitored: boolean;
  minimumAvailability: MinimumAvailability;
  tags: number[];
  searchOnAdd: boolean;
  /** Subtitle language profile; 'default' omits the field so the server default applies. */
  languageProfileId: number | null | 'default';
}

export type AddFormErrors = Partial<Record<'rootFolderPath' | 'qualityProfileId', string>>;

export const MONITOR_OPTION_LABELS: Record<MonitorOption, string> = {
  get all() {
    return t('library.addForm.allEpisodes');
  },
  get future() {
    return t('library.addForm.futureEpisodes');
  },
  get missing() {
    return t('library.addForm.missingEpisodes');
  },
  get existing() {
    return t('library.addForm.existingEpisodes');
  },
  get firstSeason() {
    return t('library.addForm.firstSeason');
  },
  get latestSeason() {
    return t('library.addForm.latestSeason');
  },
  get pilot() {
    return t('library.addForm.pilotEpisode');
  },
  get none() {
    return t('common.none');
  },
};

export const MINIMUM_AVAILABILITY_LABELS: Record<MinimumAvailability, string> = {
  get announced() {
    return t('library.addForm.announced');
  },
  get inCinemas() {
    return t('common.inCinemas');
  },
  get released() {
    return t('common.released');
  },
};

export const SERIES_TYPE_LABELS: Record<SeriesType, string> = {
  get standard() {
    return t('library.addForm.standard');
  },
  get daily() {
    return t('library.addForm.daily');
  },
  get anime() {
    return t('library.addForm.anime');
  },
};

export interface AddDefaults {
  rootFolderPath?: string | undefined;
  qualityProfileId?: number | undefined;
}

/** Initial state: remembered choices when they are still valid, else the first option. */
export function initialAddForm(
  mediaType: 'series' | 'movie',
  rootFolders: readonly RootFolder[],
  profiles: readonly QualityProfile[],
  remembered: AddDefaults = {},
): AddFormState {
  const roots = rootFolders.filter((r) => r.mediaType === mediaType);
  const root = roots.find((r) => r.path === remembered.rootFolderPath) ?? roots[0];
  const profile = profiles.find((p) => p.id === remembered.qualityProfileId) ?? profiles[0];
  return {
    rootFolderPath: root?.path ?? '',
    qualityProfileId: profile?.id ?? null,
    monitorOption: 'all',
    seriesType: 'standard',
    seasonFolder: true,
    monitored: true,
    minimumAvailability: 'released',
    tags: [],
    searchOnAdd: false,
    languageProfileId: 'default',
  };
}

export function validateAddForm(state: AddFormState): AddFormErrors {
  const errors: AddFormErrors = {};
  if (!state.rootFolderPath.trim()) errors.rootFolderPath = t('common.chooseARootFolder');
  if (state.qualityProfileId === null) errors.qualityProfileId = t('library.addForm.chooseAQualityProfile');
  return errors;
}

export function isValid(errors: AddFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

/** The add request's languageProfileId: omitted for 'default', else the id or null (none). */
function languageProfileField(s: AddFormState): { languageProfileId?: number | null } {
  return s.languageProfileId === 'default' ? {} : { languageProfileId: s.languageProfileId };
}

export function toAddSeriesRequest(tmdbId: number, s: AddFormState): AddSeriesRequest {
  if (s.qualityProfileId === null) throw new Error('quality profile is required');
  return {
    tmdbId,
    rootFolderPath: s.rootFolderPath,
    qualityProfileId: s.qualityProfileId,
    monitored: s.monitorOption !== 'none',
    monitorOption: s.monitorOption,
    monitorNewItems: s.monitorOption === 'none' ? 'none' : 'all',
    seriesType: s.seriesType,
    seasonFolder: s.seasonFolder,
    tags: s.tags,
    searchOnAdd: s.searchOnAdd,
    ...languageProfileField(s),
  };
}

export function toAddMovieRequest(tmdbId: number, s: AddFormState): AddMovieRequest {
  if (s.qualityProfileId === null) throw new Error('quality profile is required');
  return {
    tmdbId,
    rootFolderPath: s.rootFolderPath,
    qualityProfileId: s.qualityProfileId,
    monitored: s.monitored,
    minimumAvailability: s.minimumAvailability,
    tags: s.tags,
    searchOnAdd: s.searchOnAdd,
    ...languageProfileField(s),
  };
}

/** "Series · first aired 2015-12-14 · en" for a TMDB result row. */
export function resultMeta(r: MetadataSearchResult): string {
  const date = r.mediaType === 'series' ? r.firstAired : r.releaseDate;
  return [r.mediaType === 'series' ? t('common.series') : t('common.movie'), date ? (r.mediaType === 'series' ? t('library.addForm.firstAired', { date }) : t('library.addForm.released', { date })) : null, r.originalLanguage]
    .filter(Boolean)
    .join(' · ');
}

