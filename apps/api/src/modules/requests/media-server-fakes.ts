import { MediaServerSettings, type MediaServerKind } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { saveMediaServerView } from '../media-servers/index.js';

// Test-only fake media servers behind one fetch: Jellyfin (http://jf.test), Emby
// (http://emby.test), a Plex Media Server (http://plex.test) and plex.tv (http://plextv.test).
// They implement just enough of each API for the requests module's media-server features.

export interface FakeMbUser {
  id: string;
  name: string;
  password: string;
  isAdmin?: boolean;
  isDisabled?: boolean;
}

export interface FakeMbItem {
  Id: string;
  Name: string;
  Type: 'Movie' | 'Series';
  ProductionYear?: number;
  ProviderIds: Record<string, string>;
}

export interface FakeEpisode {
  season: number;
  episode: number;
  end?: number;
  virtual?: boolean;
}

export class FakeMediaBrowser {
  readonly apiKey: string;
  users: FakeMbUser[] = [];
  favorites = new Map<string, FakeMbItem[]>();
  library: FakeMbItem[] = [];
  episodes = new Map<string, FakeEpisode[]>();
  down = false;
  serverName: string;

  constructor(
    readonly kind: 'jellyfin' | 'emby',
    opts: { apiKey?: string; serverName?: string } = {},
  ) {
    this.apiKey = opts.apiKey ?? `${kind}-key`;
    this.serverName = opts.serverName ?? (kind === 'jellyfin' ? 'Den' : 'Attic');
  }

  tokenOf(userId: string): string {
    return `tok-${this.kind}-${userId}`;
  }

  private authorised(token: string | undefined, userId?: string): boolean {
    return token === this.apiKey || (userId !== undefined && token === this.tokenOf(userId));
  }

  handle(method: string, url: URL, headers: Record<string, string>, body: string | undefined): { status: number; json?: unknown } {
    const token = headers['X-Emby-Token'];
    const path = url.pathname;
    if (method === 'POST' && path === '/Users/AuthenticateByName') {
      const { Username, Pw } = JSON.parse(body ?? '{}') as { Username: string; Pw: string };
      const user = this.users.find((u) => u.name.toLowerCase() === Username.toLowerCase() && u.password === Pw);
      if (!user) return { status: 401 };
      return {
        status: 200,
        json: { AccessToken: this.tokenOf(user.id), User: { Id: user.id, Name: user.name, Policy: { IsAdministrator: user.isAdmin ?? false, IsDisabled: user.isDisabled ?? false } } },
      };
    }
    if (path === '/System/Info') return this.authorised(token) ? { status: 200, json: { ServerName: this.serverName, Version: '10.10.0' } } : { status: 401 };
    if (path === '/Users') {
      if (!this.authorised(token)) return { status: 401 };
      return { status: 200, json: this.users.map((u) => ({ Id: u.id, Name: u.name, Policy: { IsAdministrator: u.isAdmin ?? false, IsDisabled: u.isDisabled ?? false } })) };
    }
    const fav = /^\/Users\/([^/]+)\/Items$/.exec(path);
    if (fav) {
      const userId = decodeURIComponent(fav[1]!);
      if (!this.authorised(token, userId)) return { status: 401 };
      const items = this.favorites.get(userId) ?? [];
      return { status: 200, json: { Items: items, TotalRecordCount: items.length } };
    }
    if (path === '/Items') {
      if (!this.authorised(token)) return { status: 401 };
      const parent = url.searchParams.get('ParentId');
      if (parent) {
        const eps = this.episodes.get(parent) ?? [];
        return {
          status: 200,
          json: {
            Items: eps.map((e) => ({ ParentIndexNumber: e.season, IndexNumber: e.episode, ...(e.end ? { IndexNumberEnd: e.end } : {}), ...(e.virtual ? { LocationType: 'Virtual' } : {}) })),
            TotalRecordCount: eps.length,
          },
        };
      }
      const type = url.searchParams.get('IncludeItemTypes');
      const wanted = (url.searchParams.get('AnyProviderIdEquals') ?? '').split(',').filter(Boolean).map((s) => s.toLowerCase());
      const items = this.library.filter(
        (i) => i.Type === type && Object.entries(i.ProviderIds).some(([k, v]) => wanted.includes(`${k.toLowerCase()}.${v}`)),
      );
      return { status: 200, json: { Items: items, TotalRecordCount: items.length } };
    }
    return { status: 404 };
  }
}

export interface FakePlexItem {
  ratingKey: string;
  title: string;
  type: 'movie' | 'show';
  guids: string[];
  /** Show only: season index -> episodes present. */
  seasons?: Record<number, number>;
}

export class FakePlex {
  readonly ownerToken = 'plex-owner';
  readonly machineId = 'mach-1';
  items: FakePlexItem[] = [];
  /** pin id -> auth token (null while pending). */
  pins = new Map<number, string | null>();
  /** user token -> account. */
  accounts = new Map<string, { id: number; username: string; email?: string; thumb?: string }>();
  /** user token -> server machine ids it can reach. */
  access = new Map<string, string[]>();
  friends: Array<{ id: number; username: string; email?: string }> = [];
  sectionRequests = 0;
  private nextPin = 100;

  handleServer(url: URL, headers: Record<string, string>): { status: number; json?: unknown } {
    if (headers['X-Plex-Token'] !== this.ownerToken) return { status: 401 };
    const path = url.pathname;
    // Server root (the @arclight/media-servers client's info()).
    if (path === '/') return { status: 200, json: { MediaContainer: { friendlyName: 'Plex Den', machineIdentifier: this.machineId, version: '1.41' } } };
    if (path === '/identity') return { status: 200, json: { MediaContainer: { machineIdentifier: this.machineId, version: '1.41' } } };
    if (path === '/library/sections') {
      return { status: 200, json: { MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }, { key: '2', type: 'show', title: 'TV' }] } } };
    }
    const section = /^\/library\/sections\/(\d)\/all$/.exec(path);
    if (section) {
      this.sectionRequests++;
      const type = section[1] === '1' ? 'movie' : 'show';
      const rows = this.items.filter((i) => i.type === type).map((i) => ({ ratingKey: i.ratingKey, title: i.title, Guid: i.guids.map((id) => ({ id })) }));
      return { status: 200, json: { MediaContainer: { totalSize: rows.length, Metadata: rows } } };
    }
    const children = /^\/library\/metadata\/([^/]+)\/children$/.exec(path);
    if (children) {
      const item = this.items.find((i) => i.ratingKey === decodeURIComponent(children[1]!));
      const rows = Object.entries(item?.seasons ?? {}).map(([index, leafCount]) => ({ index: Number(index), leafCount }));
      return { status: 200, json: { MediaContainer: { Metadata: rows } } };
    }
    return { status: 404 };
  }

  handleTv(method: string, url: URL, headers: Record<string, string>): { status: number; json?: unknown } {
    const path = url.pathname;
    if (method === 'POST' && path === '/api/v2/pins') {
      const id = this.nextPin++;
      this.pins.set(id, null);
      return { status: 201, json: { id, code: `code${id}` } };
    }
    const pin = /^\/api\/v2\/pins\/(\d+)$/.exec(path);
    if (pin) {
      const id = Number(pin[1]);
      return this.pins.has(id) ? { status: 200, json: { id, authToken: this.pins.get(id) } } : { status: 404 };
    }
    const token = headers['X-Plex-Token'] ?? '';
    if (path === '/api/v2/user') {
      const account = this.accounts.get(token);
      return account ? { status: 200, json: account } : { status: 401 };
    }
    if (path === '/api/v2/resources') return { status: 200, json: (this.access.get(token) ?? []).map((id) => ({ clientIdentifier: id, provides: 'server' })) };
    if (path === '/api/v2/friends') return token === this.ownerToken ? { status: 200, json: this.friends } : { status: 401 };
    return { status: 404 };
  }

  /** Simulates the user approving PIN `id` in the popup. */
  approve(id: number, token: string, account: { id: number; username: string; email?: string; thumb?: string }, servers: string[] = []): void {
    this.pins.set(id, token);
    this.accounts.set(token, account);
    this.access.set(token, servers);
  }
}

export class FakeMediaServers {
  readonly jellyfin = new FakeMediaBrowser('jellyfin');
  readonly emby = new FakeMediaBrowser('emby');
  readonly plex = new FakePlex();
  readonly calls: string[] = [];

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    this.calls.push(`${method} ${url.host}${url.pathname}`);
    let out: { status: number; json?: unknown };
    switch (url.host) {
      case 'jf.test':
        if (this.jellyfin.down) throw new TypeError('fetch failed');
        out = this.jellyfin.handle(method, url, headers, body);
        break;
      case 'emby.test':
        if (this.emby.down) throw new TypeError('fetch failed');
        out = this.emby.handle(method, url, headers, body);
        break;
      case 'plex.test':
        out = this.plex.handleServer(url, headers);
        break;
      case 'plextv.test':
        out = this.plex.handleTv(method, url, headers);
        break;
      default:
        throw new TypeError(`unexpected host ${url.host}`);
    }
    return new Response(out.json === undefined ? null : JSON.stringify(out.json), { status: out.status, headers: { 'content-type': 'application/json' } });
  };
}

const HOSTS: Record<MediaServerKind, string> = { jellyfin: 'http://jf.test', emby: 'http://emby.test', plex: 'http://plex.test' };

/** Points Settings > Media servers (through the single-server view) at one of the fakes. */
export function configureServer(db: Db, servers: FakeMediaServers, kind: MediaServerKind, extra: Partial<MediaServerSettings> = {}): void {
  const apiKey = kind === 'plex' ? servers.plex.ownerToken : kind === 'jellyfin' ? servers.jellyfin.apiKey : servers.emby.apiKey;
  saveMediaServerView(db, MediaServerSettings.parse({ kind, url: HOSTS[kind], apiKey, ...extra }));
}
