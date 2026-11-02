import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { episodes, movies, series } from '../../db/schema.js';

// A fake Jellyfin HTTP server (as a fetch function) and library seeding for the watch-history and
// Jellyfin plugin tests. It answers the calls the sync and the plugin routes make: System/Info,
// Users, Items (series index, lookups by id) and Users/{id}/Items (full reads paged by
// StartIndex/Limit, incremental reads sorted by DatePlayed).

export interface FakeUserData {
  Played?: boolean;
  PlayCount?: number;
  LastPlayedDate?: string;
  PlaybackPositionTicks?: number;
  IsFavorite?: boolean;
}

export interface FakeItem {
  Id: string;
  Name: string;
  Type: 'Movie' | 'Episode' | 'Series' | 'Season';
  ProviderIds?: Record<string, string>;
  SeriesId?: string;
  SeasonId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  RunTimeTicks?: number;
}

export interface FakeAccount {
  Id: string;
  Name: string;
  IsAdministrator?: boolean;
  IsDisabled?: boolean;
  /** Jellyfin parental control score (Policy.MaxParentalRating); absent = no limit. */
  MaxParentalRating?: number;
}

export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
}

export class FakeJellyfin {
  readonly calls: FakeCall[] = [];
  accounts: FakeAccount[] = [];
  items: FakeItem[] = [];
  /** userId -> itemId -> user data. */
  userData = new Map<string, Map<string, FakeUserData>>();
  down = false;

  constructor(
    readonly serverId = 'f00dcafef00dcafef00dcafef00dcafe',
    readonly apiKey = 'jf-key',
  ) {}

  account(id: string, name: string, extra: Partial<FakeAccount> = {}): this {
    this.accounts.push({ Id: id, Name: name, ...extra });
    return this;
  }

  item(item: FakeItem): this {
    this.items.push(item);
    return this;
  }

  data(userId: string, itemId: string, data: FakeUserData): this {
    let map = this.userData.get(userId);
    if (!map) {
      map = new Map();
      this.userData.set(userId, map);
    }
    map.set(itemId, { ...map.get(itemId), ...data });
    return this;
  }

  private page<T>(rows: T[], q: URLSearchParams): { Items: T[]; TotalRecordCount: number } {
    const start = Number(q.get('StartIndex') ?? 0);
    const limit = Number(q.get('Limit') ?? rows.length);
    return { Items: rows.slice(start, start + limit), TotalRecordCount: rows.length };
  }

  private withData(userId: string, item: FakeItem): Record<string, unknown> {
    const d = this.userData.get(userId)?.get(item.Id) ?? {};
    return { ...item, UserData: { Played: false, PlayCount: 0, PlaybackPositionTicks: 0, IsFavorite: false, ...d } };
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const q = url.searchParams;
    this.calls.push({ method: init?.method ?? 'GET', path: url.pathname, query: q });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (this.down) return new Response('down', { status: 503 });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['X-Emby-Token'] !== this.apiKey) return new Response('unauthorized', { status: 401 });
    const path = url.pathname;
    if (path === '/System/Info') return json({ ServerName: 'Fake Jellyfin', Version: '12.4.0', Id: this.serverId });
    if (path === '/Users') {
      return json(this.accounts.map((a) => ({ Id: a.Id, Name: a.Name, Policy: { IsAdministrator: a.IsAdministrator ?? false, IsDisabled: a.IsDisabled ?? false, ...(a.MaxParentalRating !== undefined ? { MaxParentalRating: a.MaxParentalRating } : {}) } })));
    }
    if (path === '/Items') {
      const ids = q.get('Ids');
      if (ids) {
        const wanted = new Set(ids.split(','));
        return json({ Items: this.items.filter((i) => wanted.has(i.Id)) });
      }
      const types = (q.get('IncludeItemTypes') ?? '').split(',');
      return json(this.page(this.items.filter((i) => types.includes(i.Type)), q));
    }
    const user = /^\/Users\/([^/]+)\/Items$/.exec(path);
    if (user) {
      const userId = decodeURIComponent(user[1]!);
      const types = (q.get('IncludeItemTypes') ?? '').split(',');
      let rows = this.items.filter((i) => types.includes(i.Type)).map((i) => this.withData(userId, i));
      if (q.get('SortBy') === 'DatePlayed') {
        const played = (r: Record<string, unknown>) => ((r['UserData'] as FakeUserData).LastPlayedDate ?? '');
        rows = rows.sort((a, b) => played(b).localeCompare(played(a)));
      }
      return json(this.page(rows, q));
    }
    return new Response('not found', { status: 404 });
  };
}

const NOW_ISO = '2026-06-01T12:00:00.000Z';

export function addMovie(db: Db, tmdbId: number, title: string, opts: { imdbId?: string; added?: string; monitored?: boolean } = {}): number {
  return db
    .insert(movies)
    .values({
      tmdbId,
      imdbId: opts.imdbId ?? null,
      title,
      originalTitle: title,
      sortTitle: title.toLowerCase(),
      cleanTitle: title.toLowerCase().replace(/\W/g, ''),
      year: 2020,
      status: 'released',
      genres: [],
      images: [],
      ratings: {},
      originalLanguage: 'en',
      path: `/media/movies/${title}`,
      rootFolderPath: '/media/movies',
      qualityProfileId: 1,
      tags: [],
      added: opts.added ?? '2025-01-01T00:00:00.000Z',
      monitored: opts.monitored ?? true,
    })
    .returning()
    .get().id;
}

/** A library series with `perSeason[n]` episodes in season n+1. */
export function addSeries(db: Db, tmdbId: number, tvdbId: number, title: string, perSeason: number[]): number {
  const id = db
    .insert(series)
    .values({
      tmdbId,
      tvdbId,
      title,
      sortTitle: title.toLowerCase(),
      cleanTitle: title.toLowerCase().replace(/\W/g, ''),
      year: 2020,
      status: 'continuing',
      genres: [],
      images: [],
      ratings: {},
      originalLanguage: 'en',
      path: `/media/tv/${title}`,
      rootFolderPath: '/media/tv',
      qualityProfileId: 1,
      tags: [],
      added: '2025-01-01T00:00:00.000Z',
    })
    .returning()
    .get().id;
  perSeason.forEach((count, i) => {
    for (let e = 1; e <= count; e++) db.insert(episodes).values({ seriesId: id, seasonNumber: i + 1, episodeNumber: e, airDateUtc: '2025-01-01T00:00:00.000Z' }).run();
  });
  return id;
}

export function episodeId(db: Db, seriesId: number, season: number, episode: number): number {
  return db
    .select()
    .from(episodes)
    .where(eq(episodes.seriesId, seriesId))
    .all()
    .find((e) => e.seasonNumber === season && e.episodeNumber === episode)!.id;
}

export { NOW_ISO };
