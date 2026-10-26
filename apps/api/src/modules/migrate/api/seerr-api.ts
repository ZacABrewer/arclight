import type { MigrateSource, MigrationWarning } from '@arclight/shared';
import { MigrateError } from '../errors.js';
import { bool, int, isoDate, str } from '../foreign-db.js';
import type { SourceHttp } from '../http.js';
import { remapPath } from '../paths.js';
import type { ReadDeps } from '../readers.js';
import { buildSeerrBundle, intList, ISSUE_STATUS, ISSUE_TYPES, mainSettings, REQUEST_STATUS, splitList, USER_TYPES, type SeerrRaw } from '../seerr-reader.js';
import type { SourceBundle } from '../types.js';
import type { SeerrIssuePayload, SeerrRequestPayload, SeerrUserPayload } from '../types-requests.js';

// Overseerr / Jellyseerr read through their live API (X-Api-Key). Same normalised shape as the
// database reader; buildSeerrBundle does the mapping for both.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const P = '/api/v1';
const PAGE = 100;

/** Every result of a `{ pageInfo, results }` endpoint. */
async function paged(http: SourceHttp, path: string, query: Record<string, string> = {}): Promise<Json[]> {
  const out: Json[] = [];
  for (let skip = 0; skip < 1_000_000; skip += PAGE) {
    const body = await http.json<unknown>(`${P}${path}`, { query: { ...query, take: PAGE, skip } });
    const results = isObj(body) && Array.isArray(body['results']) ? body['results'].filter(isObj) : [];
    out.push(...results);
    const total = isObj(body) && isObj(body['pageInfo']) ? int(body['pageInfo']['results']) : null;
    if (results.length < PAGE || (total !== null && out.length >= total)) break;
  }
  return out;
}

const idOf = (v: unknown): string | null => {
  const id = isObj(v) ? int(v['id']) : int(v);
  return id === null ? null : String(id);
};

function user(u: Json): SeerrUserPayload {
  const userType = USER_TYPES[int(u['userType']) ?? 0] ?? 'unknown';
  const username = str(u['username']) || null;
  const msName = userType === 'plex' ? str(u['plexUsername']) : str(u['jellyfinUsername']);
  const settings = isObj(u['settings']) ? u['settings'] : {};
  return {
    email: str(u['email']) ?? '',
    username,
    displayName: str(u['displayName']) || username || msName || null,
    permissions: int(u['permissions']) ?? 0,
    userType,
    plexId: int(u['plexId']),
    jellyfinUserId: str(u['jellyfinUserId']) || null,
    mediaServerUsername: msName || null,
    avatar: str(u['avatar']) || null,
    movieQuotaLimit: int(u['movieQuotaLimit']),
    movieQuotaDays: int(u['movieQuotaDays']),
    tvQuotaLimit: int(u['tvQuotaLimit']),
    tvQuotaDays: int(u['tvQuotaDays']),
    locale: str(settings['locale']) || null,
    createdAt: isoDate(u['createdAt']),
  };
}

function request(r: Json, source: MigrateSource): SeerrRequestPayload {
  const media = isObj(r['media']) ? r['media'] : {};
  const type = (str(r['type']) ?? str(media['mediaType']) ?? 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
  const root = str(r['rootFolder']);
  const seasons = Array.isArray(r['seasons']) ? r['seasons'].filter(isObj) : [];
  return {
    mediaType: type,
    tmdbId: int(media['tmdbId']),
    tvdbId: int(media['tvdbId']),
    status: REQUEST_STATUS[int(r['status']) ?? 0] ?? null,
    is4k: bool(r['is4k']),
    requestedBySourceId: idOf(r['requestedBy']),
    modifiedBySourceId: idOf(r['modifiedBy']),
    seasons: seasons.flatMap((s) => {
      const n = int(s['seasonNumber']);
      return n === null ? [] : [{ seasonNumber: n, status: REQUEST_STATUS[int(s['status']) ?? 0] ?? null }];
    }),
    rootFolder: root ? remapPath(root, source.pathMappings).path : null,
    profileId: int(r['profileId']),
    tags: intList(r['tags']),
    isAutoRequest: bool(r['isAutoRequest']),
    createdAt: isoDate(r['createdAt']),
    updatedAt: isoDate(r['updatedAt']),
  };
}

function issue(i: Json): SeerrIssuePayload {
  const media = isObj(i['media']) ? i['media'] : {};
  const mt = str(media['mediaType'])?.toLowerCase();
  const comments = Array.isArray(i['comments']) ? i['comments'].filter(isObj) : [];
  return {
    issueType: ISSUE_TYPES[int(i['issueType']) ?? 0] ?? 'other',
    status: ISSUE_STATUS[int(i['status']) ?? 0] ?? 'open',
    mediaType: mt === 'tv' ? 'tv' : mt === 'movie' ? 'movie' : null,
    tmdbId: int(media['tmdbId']),
    problemSeason: int(i['problemSeason']) ?? 0,
    problemEpisode: int(i['problemEpisode']) ?? 0,
    createdBySourceId: idOf(i['createdBy']),
    modifiedBySourceId: idOf(i['modifiedBy']),
    comments: comments.map((c) => ({ userSourceId: idOf(c['user']), message: str(c['message']) ?? '', createdAt: isoDate(c['createdAt']) })),
    createdAt: isoDate(i['createdAt']),
    updatedAt: isoDate(i['updatedAt']),
  };
}

export async function readSeerrApi(source: MigrateSource, http: SourceHttp, deps: ReadDeps): Promise<SourceBundle> {
  void deps;
  const status = await http.json<unknown>(`${P}/status`);
  const version = isObj(status) ? str(status['version']) : null;
  if (!version) throw new MigrateError('WRONG_APP', `${http.baseUrl} does not answer like Overseerr or Jellyseerr`);
  const warnings: MigrationWarning[] = [];

  const [users, requests, issueList, main, sliders, overrides] = await Promise.all([
    paged(http, '/user'),
    paged(http, '/request', { filter: 'all' }),
    paged(http, '/issue', { filter: 'all' }),
    http.optionalJson<unknown>(`${P}/settings/main`, null),
    http.optionalJson<unknown>(`${P}/settings/discover`, []),
    // Jellyseerr only.
    http.optionalJson<unknown>(`${P}/overrideRule`, []),
  ]);

  // The issue list may omit comments; the detail endpoint has them.
  const issues = await http.map(issueList, async (i) => {
    if (Array.isArray(i['comments'])) return i;
    const id = int(i['id']);
    if (id === null) return i;
    const detail = await http.optionalJson<unknown>(`${P}/issue/${id}`, null);
    return isObj(detail) ? { ...i, ...detail } : i;
  });

  const raw: SeerrRaw = {
    version,
    users: users.map((u) => ({ sourceId: String(int(u['id'])), user: user(u) })),
    requests: requests.map((r) => ({ sourceId: String(int(r['id'])), request: request(r, source) })),
    issues: issues.map((i) => ({ sourceId: String(int(i['id'])), issue: issue(i) })),
    main: isObj(main) ? mainSettings(main) : null,
    sliders: (Array.isArray(sliders) ? sliders.filter(isObj) : []).map((s) => ({
      sourceId: String(int(s['id'])),
      slider: { kind: 'slider' as const, type: int(s['type']) ?? 0, order: int(s['order']) ?? 0, isBuiltIn: bool(s['isBuiltIn']), enabled: bool(s['enabled'], true), title: str(s['title']), data: str(s['data']) },
    })),
    overrides: (Array.isArray(overrides) ? overrides.filter(isObj) : []).map((o) => {
      const root = str(o['rootFolder']);
      return {
        sourceId: String(int(o['id'])),
        rule: {
          kind: 'override' as const,
          mediaType: int(o['sonarrServiceId']) !== null ? ('tv' as const) : ('movie' as const),
          users: splitList(o['users']),
          genres: intList(o['genre']),
          languages: splitList(o['language']),
          keywords: intList(o['keywords']),
          profileId: int(o['profileId']),
          rootFolder: root ? remapPath(root, source.pathMappings).path : null,
          tags: intList(o['tags']),
        },
      };
    }),
  };
  return buildSeerrBundle(raw, warnings);
}
