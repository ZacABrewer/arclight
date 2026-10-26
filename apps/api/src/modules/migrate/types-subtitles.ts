import type { LanguageProfileFlagMode, SubtitleHistoryAction } from '@arclight/shared';

// Normalised Bazarr data, produced by the file reader (bazarr-reader.ts) and the API reader
// (api/bazarr-api.ts) alike, applied by areas-subtitles.ts. Paths are already remapped to what
// Arclight sees. Media references keep Bazarr's Sonarr/Radarr ids next to the path and external
// ids, so the handlers can find the series/movie whichever way it came into Arclight.

export interface BazarrMediaRef {
  mediaType: 'series' | 'movie';
  /** Series or movie folder (assignments) when known. */
  path: string | null;
  title: string | null;
  tvdbId: number | null;
  tmdbId: number | null;
  imdbId: string | null;
  sonarrSeriesId: number | null;
  sonarrEpisodeId: number | null;
  radarrMovieId: number | null;
}

export interface SubtitleProfilePayload {
  name: string;
  languages: Array<{ code: string; forced: LanguageProfileFlagMode; hi: LanguageProfileFlagMode }>;
  /** Language code, `*` (any) or null (every language wanted). */
  cutoff: string | null;
  mustContain: string[];
  mustNotContain: string[];
  originalFormat: boolean;
  /** Bazarr auto-assign tag (not used by Arclight). */
  tag: string | null;
}

export interface SubtitleAssignmentPayload extends BazarrMediaRef {
  /** Bazarr languages profile id (the sourceId of a subtitleProfiles item). */
  sourceProfileId: number;
}

export interface SubtitleProviderPayload {
  /** `defaults` carries the default series/movie profiles instead of a provider. */
  kind: 'provider' | 'defaults';
  provider: string;
  enabled: boolean;
  /** Arclight setting names → values (provider), or `{ seriesProfile, movieProfile }` (defaults). */
  settings: Record<string, unknown>;
}

export interface SubtitleFilePayload extends BazarrMediaRef {
  videoPath: string | null;
  subtitlePath: string;
  language: string;
  forced: boolean;
  hi: boolean;
  size: number | null;
}

export interface SubtitleEventPayload extends BazarrMediaRef {
  kind: 'history' | 'blacklist';
  action: SubtitleHistoryAction;
  description: string;
  language: string;
  forced: boolean;
  hi: boolean;
  provider: string | null;
  score: number | null;
  subsId: string | null;
  videoPath: string | null;
  subtitlesPath: string | null;
  timestamp: string | null;
}
