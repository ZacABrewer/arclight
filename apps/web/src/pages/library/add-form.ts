import type {
  AddMovieRequest,
  AddSeriesRequest,
  MinimumAvailability,
  MonitorOption,
  QualityProfile,
  RootFolder,
  SeriesType,
} from '@media-tron/shared';

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
  all: 'All episodes',
  future: 'Future episodes',
  missing: 'Missing episodes',
  existing: 'Existing episodes',
  firstSeason: 'First season',
  latestSeason: 'Latest season',
  pilot: 'Pilot episode',
  none: 'None',
};

export const MINIMUM_AVAILABILITY_LABELS: Record<MinimumAvailability, string> = {
  announced: 'Announced',
  inCinemas: 'In cinemas',
  released: 'Released',
};

export const SERIES_TYPE_LABELS: Record<SeriesType, string> = {
  standard: 'Standard',
  daily: 'Daily',
  anime: 'Anime',
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
  if (!state.rootFolderPath.trim()) errors.rootFolderPath = 'Choose a root folder';
  if (state.qualityProfileId === null) errors.qualityProfileId = 'Choose a quality profile';
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
