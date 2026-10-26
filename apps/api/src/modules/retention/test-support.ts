import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  FindItemsQuery,
  ItemPlayState,
  MediaKind,
  MediaServerClient,
  MediaServerItem,
  MediaServerKind,
  MediaServerLibrary,
  MediaServerUser,
  PlayState,
  ProviderIds,
  ServerInfo,
} from '@arclight/media-servers';
import { AddMovieRequest, AddSeriesRequest, QUALITIES, QualityModel, type MediaServerConfig } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { libraryService } from '../library/index.js';
import type { ConfiguredClient } from '../media-servers/index.js';
import * as tables from './schema.js';

/** In-memory media server for tests. Not used by production code. */
export class FakeMediaServer implements MediaServerClient {
  serverUsers: MediaServerUser[] = [];
  /** userId -> mediaType -> entries */
  private readonly plays = new Map<string, Map<MediaKind, ItemPlayState[]>>();
  fail: Error | null = null;
  refreshed: Array<{ path?: string }> = [];
  private seq = 0;

  constructor(
    readonly kind: MediaServerKind = 'jellyfin',
    readonly name = 'Fake',
  ) {}

  user(name: string, extra: Partial<MediaServerUser> = {}): string {
    const id = `${this.name}-${name}`;
    this.serverUsers.push({ id, name, isAdmin: false, isDisabled: false, lastActivityAt: null, ...extra });
    return id;
  }

  /** Records that `userName` can see the item, with its play state. */
  play(userName: string, mediaType: MediaKind, ids: Partial<ProviderIds>, state: { played: boolean; lastPlayedAt?: string | null }): void {
    const user = this.serverUsers.find((u) => u.name === userName);
    if (!user) throw new Error(`unknown fake user ${userName}`);
    const byType = this.plays.get(user.id) ?? new Map<MediaKind, ItemPlayState[]>();
    const list = byType.get(mediaType) ?? [];
    const item: MediaServerItem = {
      id: `item-${++this.seq}`,
      mediaType,
      title: 'x',
      year: null,
      ids: { tmdbId: ids.tmdbId ?? null, tvdbId: ids.tvdbId ?? null, imdbId: ids.imdbId ?? null },
      path: null,
      libraryId: null,
    };
    const ps: PlayState = {
      userId: user.id,
      played: state.played,
      playCount: state.played ? 1 : 0,
      lastPlayedAt: state.lastPlayedAt ?? null,
      positionMs: 0,
      durationMs: null,
    };
    list.push({ item, state: ps });
    byType.set(mediaType, list);
    this.plays.set(user.id, byType);
  }

  async info(): Promise<ServerInfo> {
    if (this.fail) throw this.fail;
    return { name: this.name, version: '1.0' };
  }
  async libraries(): Promise<MediaServerLibrary[]> {
    if (this.fail) throw this.fail;
    return [{ id: 'lib1', name: 'Movies', type: 'movie', locations: ['/movies'] }];
  }
  async users(): Promise<MediaServerUser[]> {
    if (this.fail) throw this.fail;
    return this.serverUsers;
  }
  async listItems(mediaType: MediaKind): Promise<MediaServerItem[]> {
    return [...this.plays.values()].flatMap((m) => (m.get(mediaType) ?? []).map((p) => p.item));
  }
  async findItems(query: FindItemsQuery): Promise<MediaServerItem[]> {
    return (await this.listItems(query.mediaType)).filter((i) => (query.tmdbId ? i.ids.tmdbId === query.tmdbId : false));
  }
  async playState(item: Pick<MediaServerItem, 'id' | 'mediaType'>, userId: string): Promise<PlayState> {
    const found = (this.plays.get(userId)?.get(item.mediaType) ?? []).find((p) => p.item.id === item.id);
    return found?.state ?? { userId, played: false, playCount: 0, lastPlayedAt: null, positionMs: 0, durationMs: null };
  }
  async listPlayStates(userId: string, mediaType: MediaKind): Promise<ItemPlayState[]> {
    if (this.fail) throw this.fail;
    return this.plays.get(userId)?.get(mediaType) ?? [];
  }
  async refreshLibrary(options: { path?: string } = {}): Promise<void> {
    this.refreshed.push(options);
  }
}

export function configured(server: FakeMediaServer, extra: Partial<MediaServerConfig> = {}): ConfiguredClient {
  return {
    config: {
      id: server.name,
      kind: server.kind,
      name: server.name,
      url: 'http://fake',
      apiKey: 'k',
      enabled: true,
      usedForAvailability: true,
      usedForRetention: true,
      usedForRefresh: false,
      loginEnabled: false,
      createUsersOnLogin: false,
      ...extra,
    },
    client: server,
  };
}

export const NOW = new Date('2026-10-26T12:00:00.000Z');
export const daysAgo = (days: number, from: Date = NOW): string => new Date(from.getTime() - days * 86_400_000).toISOString();

export interface LibraryFixture {
  db: Db;
  tmp: string;
  movieRoot: string;
  tvRoot: string;
  binPath: string;
}

export async function setupLibrary(): Promise<LibraryFixture> {
  const db = await createTestDb({ ...tables });
  const tmp = await mkdtemp(join(tmpdir(), 'arclight-retention-'));
  const movieRoot = join(tmp, 'movies');
  const tvRoot = join(tmp, 'tv');
  const binPath = join(tmp, 'recycle');
  await mkdir(movieRoot, { recursive: true });
  await mkdir(tvRoot, { recursive: true });
  await libraryService.addRootFolder(db, { path: movieRoot, mediaType: 'movie' });
  await libraryService.addRootFolder(db, { path: tvRoot, mediaType: 'series' });
  return { db, tmp, movieRoot, tvRoot, binPath };
}

const QUALITY = QualityModel.parse({ quality: QUALITIES['Bluray-1080p'], revision: { version: 1, real: 0, isRepack: false } });

/** Adds a movie (optionally with a real file on disk) added `addedDaysAgo` before NOW. */
export async function addMovie(
  fx: LibraryFixture,
  opts: { tmdbId: number; title: string; addedDaysAgo?: number; sizeBytes?: number; withFile?: boolean; tags?: number[]; collection?: boolean; imdbId?: string },
): Promise<number> {
  const movie = libraryService.addMovie(
    fx.db,
    {
      tmdbId: opts.tmdbId,
      title: opts.title,
      year: 2020,
      status: 'released',
      ...(opts.imdbId ? { imdbId: opts.imdbId } : {}),
      ...(opts.collection ? { collection: { tmdbId: 1, title: 'Saga' } } : {}),
    },
    AddMovieRequest.parse({ tmdbId: opts.tmdbId, rootFolderPath: fx.movieRoot, qualityProfileId: 1, tags: opts.tags ?? [] }),
    daysAgo(opts.addedDaysAgo ?? 100),
  );
  if (opts.withFile !== false) {
    await mkdir(movie.path, { recursive: true });
    const file = join(movie.path, `${opts.title}.mkv`);
    await writeFile(file, 'video');
    await writeFile(join(movie.path, `${opts.title}.en.srt`), 'subs');
    libraryService.addMediaFile(fx.db, {
      mediaType: 'movie',
      movieId: movie.id,
      relativePath: `${opts.title}.mkv`,
      path: file,
      sizeBytes: opts.sizeBytes ?? 1_000_000,
      quality: QUALITY,
      languages: ['en'],
    });
  }
  return movie.id;
}

export async function addSeries(fx: LibraryFixture, opts: { tmdbId: number; tvdbId?: number; title: string; addedDaysAgo?: number }): Promise<number> {
  const s = libraryService.addSeries(
    fx.db,
    {
      tmdbId: opts.tmdbId,
      tvdbId: opts.tvdbId ?? null,
      title: opts.title,
      year: 2021,
      status: 'ended',
      seasons: [{ seasonNumber: 1 }],
      episodes: [{ seasonNumber: 1, episodeNumber: 1, airDateUtc: '2021-01-01T00:00:00Z' }],
    },
    AddSeriesRequest.parse({ tmdbId: opts.tmdbId, rootFolderPath: fx.tvRoot, qualityProfileId: 1 }),
    daysAgo(opts.addedDaysAgo ?? 100),
  );
  return s.id;
}
