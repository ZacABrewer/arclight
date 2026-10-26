import {
  createTmdbClient,
  isMetadataError,
  type EpisodeMetadata,
  type MovieMetadata,
  type SearchResult,
  type SeriesMetadata,
  type TmdbClient,
  type TmdbClientOptions,
} from '@media-tron/metadata';
import type { MetadataSearchType } from '@media-tron/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import type { MovieMetadataInput, SeriesMetadataInput } from '../library/index.js';
import { settingsService } from '../settings/index.js';
import { toMovieMetadataInput, toSeriesMetadataInput } from './map.js';

/** Thrown when neither the settings nor the environment provide a TMDB API key. */
export class MetadataNotConfiguredError extends Error {
  readonly code = 'NOT_CONFIGURED';
  constructor() {
    super('TMDB API key is not configured; set it in Settings > Metadata or MEDIATRON_TMDB_API_KEY');
    this.name = 'MetadataNotConfiguredError';
  }
}

export interface MetadataServiceOptions {
  db: Db;
  log: Logger;
  /** Environment to read MEDIATRON_TMDB_API_KEY from; injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Client factory; injectable so tests never talk to TMDB. */
  createClient?: (options: TmdbClientOptions) => TmdbClient;
}

interface EffectiveOptions {
  apiKey: string;
  language: string;
  region: string;
}

// Wraps the TMDB client. The client is built on first use and rebuilt whenever the effective
// options (key, language, region) change, so a key saved in the UI takes effect on the next
// request without a restart. Settings are read per call; it is one primary-key lookup.
export class MetadataService {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly createClient: (options: TmdbClientOptions) => TmdbClient;
  private cached: { fingerprint: string; client: TmdbClient } | null = null;

  constructor(opts: MetadataServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.env = opts.env ?? process.env;
    this.createClient = opts.createClient ?? createTmdbClient;
  }

  private effectiveOptions(): EffectiveOptions | null {
    const stored = settingsService.getSection(this.db, 'metadata');
    const apiKey = stored.tmdbApiKey ?? this.env['MEDIATRON_TMDB_API_KEY']?.trim();
    if (!apiKey) return null;
    return { apiKey, language: stored.language, region: stored.region };
  }

  isConfigured(): boolean {
    return this.effectiveOptions() !== null;
  }

  client(): TmdbClient {
    const options = this.effectiveOptions();
    if (!options) {
      this.cached = null;
      throw new MetadataNotConfiguredError();
    }
    const fingerprint = [options.apiKey, options.language, options.region].join('|');
    if (!this.cached || this.cached.fingerprint !== fingerprint) {
      if (this.cached) this.log.info('metadata settings changed; rebuilding TMDB client');
      this.cached = { fingerprint, client: this.createClient(options) };
    }
    return this.cached.client;
  }

  async search(query: string, type: MetadataSearchType): Promise<SearchResult[]> {
    const client = this.client();
    const page =
      type === 'series'
        ? await client.searchSeries(query)
        : type === 'movie'
          ? await client.searchMovies(query)
          : await client.searchMulti(query);
    return page.results;
  }

  getSeries(tmdbId: number): Promise<SeriesMetadata> {
    return this.client().getSeries(tmdbId);
  }

  getMovie(tmdbId: number): Promise<MovieMetadata> {
    return this.client().getMovie(tmdbId);
  }

  /** Series details plus every season's episodes, fetched one season at a time to respect rate limits. */
  async getSeriesWithEpisodes(tmdbId: number): Promise<{ series: SeriesMetadata; episodes: EpisodeMetadata[] }> {
    const client = this.client();
    const series = await client.getSeries(tmdbId);
    const episodes: EpisodeMetadata[] = [];
    for (const season of series.seasons) {
      episodes.push(...(await client.getSeason(tmdbId, season.seasonNumber)));
    }
    return { series, episodes };
  }

  /** Library-shaped series metadata, or null when TMDB has no such series. */
  async lookupSeries(tmdbId: number): Promise<SeriesMetadataInput | null> {
    try {
      const { series, episodes } = await this.getSeriesWithEpisodes(tmdbId);
      return toSeriesMetadataInput(series, episodes);
    } catch (err) {
      if (isMetadataError(err, 'not-found')) return null;
      throw err;
    }
  }

  /** Library-shaped movie metadata, or null when TMDB has no such movie. */
  async lookupMovie(tmdbId: number): Promise<MovieMetadataInput | null> {
    try {
      return toMovieMetadataInput(await this.getMovie(tmdbId));
    } catch (err) {
      if (isMetadataError(err, 'not-found')) return null;
      throw err;
    }
  }
}
