import {
  createDeezerClient,
  createLastfmClient,
  createSpotifyClient,
  defaultRateLimiter,
  MetadataError,
  type DeezerClient,
  type FetchLike,
  type LastfmClient,
  type ListenBrainzClient,
  type RateLimiter,
  type SourcePlaylist,
  type SpotifyClient,
} from '@arclight/metadata';
import type { MusicPlaylistsSettings, PlaylistSource } from '@arclight/shared';

// The outside services a playlist reads from. Clients are built from the `musicPlaylists`
// settings and rebuilt when the keys change; ListenBrainz comes from the music metadata
// service (keyless, shared User-Agent). Tests inject a fake fetch through the overrides.

export interface PlaylistProviderOverrides {
  fetchImpl?: FetchLike;
  rateLimiter?: RateLimiter;
  now?: () => Date;
}

export class PlaylistError extends Error {
  constructor(
    readonly code: 'NOT_CONFIGURED' | 'SOURCE_FAILED' | 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PlaylistError';
  }
}

/** Upper bound on tracks read from one source (MusicBrainz matching is 1 request per second). */
export const MAX_SOURCE_TRACKS = 500;

export class PlaylistProviders {
  private spotify: { key: string; value: SpotifyClient } | null = null;
  private lastfm: { key: string; value: LastfmClient } | null = null;
  private deezer: DeezerClient | null = null;

  constructor(
    private readonly deps: {
      settings: () => MusicPlaylistsSettings;
      listenBrainz: () => ListenBrainzClient | null;
      /** A Last.fm key from elsewhere (the music metadata section) when this section has none. */
      fallbackLastfmKey?: () => string | undefined;
      overrides?: PlaylistProviderOverrides;
    },
  ) {}

  private common() {
    const o = this.deps.overrides ?? {};
    return {
      rateLimiter: o.rateLimiter ?? defaultRateLimiter,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.now ? { now: o.now } : {}),
    };
  }

  spotifyClient(): SpotifyClient {
    const s = this.deps.settings();
    if (!s.spotifyClientId || !s.spotifyClientSecret) {
      throw new PlaylistError('NOT_CONFIGURED', 'Spotify needs a client id and secret (Settings → Music playlists).', 409);
    }
    const key = `${s.spotifyClientId}\u0000${s.spotifyClientSecret}`;
    if (this.spotify?.key !== key) {
      this.spotify = { key, value: createSpotifyClient({ clientId: s.spotifyClientId, clientSecret: s.spotifyClientSecret, ...this.common() }) };
    }
    return this.spotify.value;
  }

  lastfmKey(): string {
    return this.deps.settings().lastfmApiKey || this.deps.fallbackLastfmKey?.() || '';
  }

  /** Null without a key (similar artists then use ListenBrainz alone). */
  lastfmClient(): LastfmClient | null {
    const key = this.lastfmKey();
    if (!key) return null;
    if (this.lastfm?.key !== key) this.lastfm = { key, value: createLastfmClient({ apiKey: key, ...this.common() }) };
    return this.lastfm.value;
  }

  deezerClient(): DeezerClient {
    this.deezer ??= createDeezerClient(this.common());
    return this.deezer;
  }

  listenBrainz(): ListenBrainzClient {
    const client = this.deps.listenBrainz();
    if (!client) throw new PlaylistError('NOT_CONFIGURED', 'The music metadata service is not running.', 503);
    return client;
  }

  /** Reads the source as it is now. Outside failures become SOURCE_FAILED (502) with the provider's reason. */
  async load(source: PlaylistSource, signal?: AbortSignal): Promise<SourcePlaylist> {
    const opts = signal ? { signal } : {};
    try {
      const playlist = await this.read(source, opts);
      return { ...playlist, tracks: playlist.tracks.slice(0, MAX_SOURCE_TRACKS) };
    } catch (err) {
      if (err instanceof PlaylistError) throw err;
      if (err instanceof MetadataError) {
        if (err.code === 'not-found') throw new PlaylistError('NOT_FOUND', `The playlist was not found (${err.message}).`, 404);
        throw new PlaylistError('SOURCE_FAILED', err.message, 502);
      }
      throw err;
    }
  }

  private async read(source: PlaylistSource, opts: { signal?: AbortSignal }): Promise<SourcePlaylist> {
    switch (source.kind) {
      case 'spotify':
        return this.spotifyClient().getPlaylist(source.url, opts);
      case 'deezer':
        return this.deezerClient().getPlaylist(source.url, opts);
      case 'listenbrainz':
        return this.listenBrainz().getPlaylist(source.url, opts);
      case 'listenbrainzCreatedFor': {
        const lb = this.listenBrainz();
        const list = await lb.createdForPlaylists(source.user, { ...opts, count: 50 });
        const patch = source.patch.trim().toLowerCase();
        const pick = list
          .filter((p) => !patch || p.sourcePatch?.toLowerCase() === patch)
          .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
        if (!pick) throw new PlaylistError('NOT_FOUND', `ListenBrainz has no ${patch || 'created-for'} playlist for ${source.user}.`, 404);
        return lb.getPlaylist(pick.mbid, opts);
      }
      case 'lastfm': {
        const client = this.lastfmClient();
        if (!client) throw new PlaylistError('NOT_CONFIGURED', 'Last.fm needs an API key (Settings → Music playlists).', 409);
        const tracks =
          source.chart === 'loved'
            ? await client.lovedTracks({ user: source.user, limit: source.limit }, opts)
            : await client.topTracks({ user: source.user, limit: source.limit, period: source.period }, opts);
        const title = source.chart === 'loved' ? `${source.user}: loved tracks` : `${source.user}: top tracks (${source.period})`;
        return { id: `lastfm:${source.user}:${source.chart}`, title, owner: source.user, tracks: tracks.slice(0, source.limit) };
      }
    }
  }
}
