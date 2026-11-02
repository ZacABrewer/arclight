// A fake Plex Media Server plus the plex.tv endpoints the watch-history sync calls, as one fetch
// function (routed by host and path). Response shapes follow Plex's public API documentation:
// PMS answers `{ MediaContainer: { ... } }` (JSON with Accept: application/json), plex.tv v2
// answers bare objects and arrays. Times are Unix seconds, durations and offsets milliseconds.

export interface FakePlexMovie {
  ratingKey: string;
  title: string;
  /** New-agent GUIDs, e.g. `tmdb://603`. */
  guids: string[];
  duration?: number;
}

export interface FakePlexEpisode {
  ratingKey: string;
  title: string;
  season: number;
  index: number;
  guids?: string[];
  duration?: number;
}

export interface FakePlexShow {
  ratingKey: string;
  title: string;
  guids: string[];
  seasons: Record<number, string>;
  episodes: FakePlexEpisode[];
}

export interface FakePlexState {
  viewCount?: number;
  lastViewedAt?: number;
  viewOffset?: number;
}

export interface FakePlexSession {
  sessionKey: string;
  ratingKey: string;
  accountId: string;
  accountName: string;
  player: string;
  state?: 'playing' | 'paused';
  viewOffset: number;
  transcode?: boolean;
}

export const PLEX_URL = 'http://plex.test:32400';

export class FakePlex {
  readonly calls: Array<{ host: string; path: string; query: URLSearchParams; token: string | null }> = [];
  machineId = 'fakeplexmachine01';
  owner = { plexTvId: '9000001', name: 'owner' };
  /** Accounts the server's /accounts lists besides the owner (local id = plex.tv id). */
  local: Array<{ id: string; name: string }> = [];
  friends: Array<{ id: string; title: string; status?: string; machine?: string; restricted?: boolean }> = [];
  home: Array<{ id: string; title: string; restricted: boolean }> = [];
  /** A user's plex.tv token -> their server token. */
  userTokens = new Map<string, string>();
  movies: FakePlexMovie[] = [];
  shows: FakePlexShow[] = [];
  /** token ('owner' or a server token) -> ratingKey -> state. */
  state = new Map<string, Map<string, FakePlexState>>();
  history: Array<{ accountID: string; ratingKey: string; viewedAt: number }> = [];
  sessions: FakePlexSession[] = [];
  plexTvDown = false;

  constructor(readonly token = 'plex-owner-token') {}

  setState(who: string, ratingKey: string, s: FakePlexState): this {
    let m = this.state.get(who);
    if (!m) this.state.set(who, (m = new Map()));
    m.set(ratingKey, s);
    return this;
  }

  watched(accountID: string, ratingKey: string, viewedAt: number): this {
    this.history.push({ accountID, ratingKey, viewedAt });
    return this;
  }

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = headers['X-Plex-Token'] ?? url.searchParams.get('X-Plex-Token');
    this.calls.push({ host: url.host, path: url.pathname, query: url.searchParams, token });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.host === 'plex.tv') {
      if (this.plexTvDown) return new Response('unavailable', { status: 503 });
      return this.plexTv(url.pathname, token, json);
    }
    const who = token === this.token ? 'owner' : [...this.userTokens.values()].includes(token ?? '') ? token! : null;
    if (!who) return new Response('unauthorized', { status: 401 });
    return this.pms(url, who, json);
  };

  private plexTv(path: string, token: string | null, json: (b: unknown) => Response): Response {
    if (path === '/api/v2/resources') {
      const serverToken = token === this.token ? this.token : token ? this.userTokens.get(token) : undefined;
      if (!serverToken) return new Response('unauthorized', { status: 401 });
      return json([{ name: 'Fake Plex', provides: 'server', clientIdentifier: this.machineId, accessToken: serverToken }]);
    }
    if (token !== this.token) return new Response('unauthorized', { status: 401 });
    if (path === '/api/v2/user') return json({ id: Number(this.owner.plexTvId), username: this.owner.name, title: this.owner.name });
    if (path === '/api/v2/friends') {
      return json(
        this.friends.map((f) => ({
          id: Number(f.id),
          title: f.title,
          username: f.title,
          restricted: f.restricted ?? false,
          status: f.status ?? 'accepted',
          sharedServers: [{ machineIdentifier: f.machine ?? this.machineId }],
        })),
      );
    }
    if (path === '/api/v2/home/users') {
      return json({
        users: [
          { id: Number(this.owner.plexTvId), title: this.owner.name, admin: true, restricted: false },
          ...this.home.map((u) => ({ id: Number(u.id), title: u.title, admin: false, restricted: u.restricted })),
        ],
      });
    }
    return new Response('not found', { status: 404 });
  }

  meta(ratingKey: string, who: string): Record<string, unknown> | null {
    const s = this.state.get(who)?.get(ratingKey) ?? {};
    const own = { ...(s.viewCount ? { viewCount: s.viewCount } : {}), ...(s.lastViewedAt ? { lastViewedAt: s.lastViewedAt } : {}), ...(s.viewOffset ? { viewOffset: s.viewOffset } : {}) };
    const movie = this.movies.find((m) => m.ratingKey === ratingKey);
    if (movie) {
      return { ratingKey, key: `/library/metadata/${ratingKey}`, type: 'movie', title: movie.title, librarySectionID: 1, duration: movie.duration ?? 6_000_000, Guid: movie.guids.map((id) => ({ id })), ...own };
    }
    for (const show of this.shows) {
      if (show.ratingKey === ratingKey) {
        const viewed = show.episodes.filter((e) => (this.state.get(who)?.get(e.ratingKey)?.viewCount ?? 0) > 0).length;
        return { ratingKey, key: `/library/metadata/${ratingKey}/children`, type: 'show', title: show.title, librarySectionID: 2, Guid: show.guids.map((id) => ({ id })), leafCount: show.episodes.length, viewedLeafCount: viewed };
      }
      const ep = show.episodes.find((e) => e.ratingKey === ratingKey);
      if (ep) {
        return {
          ratingKey,
          key: `/library/metadata/${ratingKey}`,
          type: 'episode',
          title: ep.title,
          grandparentTitle: show.title,
          grandparentRatingKey: show.ratingKey,
          grandparentKey: `/library/metadata/${show.ratingKey}`,
          parentRatingKey: show.seasons[ep.season] ?? null,
          parentIndex: ep.season,
          index: ep.index,
          duration: ep.duration ?? 2_700_000,
          Guid: (ep.guids ?? []).map((id) => ({ id })),
          ...own,
        };
      }
    }
    return null;
  }

  private page(url: URL, rows: Record<string, unknown>[], json: (b: unknown) => Response): Response {
    const start = Number(url.searchParams.get('X-Plex-Container-Start') ?? 0);
    const size = Number(url.searchParams.get('X-Plex-Container-Size') ?? 500);
    const slice = rows.slice(start, start + size);
    return json({ MediaContainer: { size: slice.length, totalSize: rows.length, offset: start, Metadata: slice } });
  }

  private pms(url: URL, who: string, json: (b: unknown) => Response): Response {
    const path = url.pathname;
    if (path === '/') return json({ MediaContainer: { friendlyName: 'Fake Plex', version: '1.41.0', machineIdentifier: this.machineId } });
    if (path === '/library/sections') {
      return json({
        MediaContainer: {
          Directory: [
            { key: '1', title: 'Movies', type: 'movie', Location: [{ path: '/media/movies' }] },
            { key: '2', title: 'TV', type: 'show', Location: [{ path: '/media/tv' }] },
          ],
        },
      });
    }
    if (path === '/accounts') {
      return json({ MediaContainer: { Account: [{ id: 0, name: '' }, { id: 1, name: this.owner.name }, ...this.local.map((a) => ({ id: Number(a.id), name: a.name }))] } });
    }
    const section = /^\/library\/sections\/(\d+)\/all$/.exec(path);
    if (section) {
      const type = url.searchParams.get('type');
      let keys: string[];
      if (section[1] === '1') keys = this.movies.map((m) => m.ratingKey);
      else if (type === '4') keys = this.shows.flatMap((s) => s.episodes.map((e) => e.ratingKey));
      else keys = this.shows.map((s) => s.ratingKey);
      let rows = keys.map((k) => this.meta(k, who)!);
      if (url.searchParams.get('sort') === 'lastViewedAt:desc') rows = rows.sort((a, b) => Number(b['lastViewedAt'] ?? 0) - Number(a['lastViewedAt'] ?? 0));
      return this.page(url, rows, json);
    }
    if (path === '/status/sessions/history/all') {
      const account = url.searchParams.get('accountID');
      const item = url.searchParams.get('metadataItemID');
      const rows = this.history
        .filter((h) => (!account || h.accountID === account) && (!item || h.ratingKey === item))
        .sort((a, b) => b.viewedAt - a.viewedAt)
        .map((h) => {
          const m = this.meta(h.ratingKey, 'owner') ?? {};
          return { historyKey: `/status/sessions/history/${h.viewedAt}`, ratingKey: h.ratingKey, key: `/library/metadata/${h.ratingKey}`, type: m['type'], title: m['title'], grandparentKey: m['grandparentKey'], viewedAt: h.viewedAt, accountID: Number(h.accountID) };
        });
      return this.page(url, rows, json);
    }
    const metadata = /^\/library\/metadata\/([\d,]+)$/.exec(path);
    if (metadata) {
      const rows = (metadata[1] ?? '').split(',').flatMap((k) => this.meta(k, who) ?? []);
      if (rows.length === 0) return new Response('not found', { status: 404 });
      return json({ MediaContainer: { size: rows.length, Metadata: rows } });
    }
    if (path === '/status/sessions') {
      return json({
        MediaContainer: {
          size: this.sessions.length,
          Metadata: this.sessions.map((s) => ({
            ...this.meta(s.ratingKey, 'owner'),
            sessionKey: s.sessionKey,
            viewOffset: s.viewOffset,
            User: { id: s.accountId, title: s.accountName },
            Player: { machineIdentifier: s.player, title: `${s.player} device`, product: 'Plex Web', state: s.state ?? 'playing' },
            Session: { id: `sess-${s.sessionKey}` },
            ...(s.transcode ? { TranscodeSession: { videoDecision: 'transcode', audioDecision: 'copy' } } : {}),
          })),
        },
      });
    }
    return new Response('not found', { status: 404 });
  }
}

/** A Plex webhook as Plex sends it: multipart/form-data with the JSON in `payload` (and sometimes a thumb). */
export function plexWebhookBody(payload: Record<string, unknown>, opts: { thumb?: boolean } = {}): { payload: string; headers: Record<string, string> } {
  const boundary = '----plexwebhookboundary';
  const parts = [`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`];
  if (opts.thumb) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="thumb"; filename="thumb.jpg"\r\nContent-Type: image/jpeg\r\n\r\nJPEGDATA\r\n`);
  parts.push(`--${boundary}--\r\n`);
  return { payload: parts.join(''), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** The webhook payload Plex posts for one playback event. */
export function plexEvent(
  event: string,
  fake: FakePlex,
  opts: { accountId: string; accountName: string; player: string; ratingKey: string; viewOffset?: number },
): Record<string, unknown> {
  const meta = fake.meta(opts.ratingKey, 'owner') ?? {};
  return {
    event,
    user: true,
    owner: opts.accountId === '1',
    Account: { id: Number(opts.accountId), title: opts.accountName },
    Server: { title: 'Fake Plex', uuid: fake.machineId },
    Player: { local: true, title: `${opts.player} device`, uuid: opts.player },
    Metadata: { ...meta, ...(opts.viewOffset !== undefined ? { viewOffset: opts.viewOffset } : {}) },
  };
}
