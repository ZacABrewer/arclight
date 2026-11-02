import type { AnilistSettings, ImportListMediaType, KitsuSettings, MyAnimeListSettings } from '@arclight/shared';
import { ImportListFetchError } from '../errors.js';
import { animeItem, animeKind, currentSeason, loadAnimeIds, type AnimeIdIndex } from './anime-ids.js';
import { asArray, asRecord, getJson, int, str, USER_AGENT } from './http.js';
import { wants, yearOf, type FetchedItem, type Provider, type ProviderContext } from './types.js';

// Anime lists: AniList (public GraphQL), MyAnimeList (API v2, client id) and Kitsu (JSON:API).
// Entries map to library series/movies through the anime id mapping (anime-ids.ts); Kitsu also
// exposes its own MAL mappings, which feed the same index.

function push(
  out: FetchedItem[],
  mediaType: ImportListMediaType,
  item: { kind: 'series' | 'movie' | null; ids: ReturnType<AnimeIdIndex['anilist']>; title: string | null; year: number | null },
): void {
  if (!item.kind || !item.title || !wants(mediaType, item.kind)) return;
  out.push(animeItem(item.ids, { kind: item.kind, title: item.title, year: item.year }));
}

// ---- AniList ----------------------------------------------------------------------------

export const ANILIST_URL = 'https://graphql.anilist.co';
const ANILIST_STATUS = {
  current: 'CURRENT',
  planning: 'PLANNING',
  completed: 'COMPLETED',
  paused: 'PAUSED',
  dropped: 'DROPPED',
  repeating: 'REPEATING',
} as const;
const ANILIST_SORT = { trending: 'TRENDING_DESC', popular: 'POPULARITY_DESC', top: 'SCORE_DESC', seasonal: 'POPULARITY_DESC' } as const;
const MEDIA_FIELDS = 'id idMal format title { romaji english } startDate { year } seasonYear';

async function anilistQuery(ctx: ProviderContext, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = asRecord(
    await getJson(ctx, 'AniList', ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ query, variables }),
    }),
  );
  const errors = asArray(body?.['errors']);
  if (errors.length) {
    const message = str(asRecord(errors[0])?.['message']) ?? 'query failed';
    const status = int(asRecord(errors[0])?.['status']);
    throw new ImportListFetchError(status === 404 ? 'not-found' : 'bad-response', `AniList: ${message}`);
  }
  return asRecord(body?.['data']) ?? {};
}

function anilistEntry(media: unknown) {
  const m = asRecord(media);
  const title = asRecord(m?.['title']);
  return {
    id: int(m?.['id']),
    kind: animeKind(str(m?.['format'])),
    title: str(title?.['english']) ?? str(title?.['romaji']),
    year: int(asRecord(m?.['startDate'])?.['year']) ?? int(m?.['seasonYear']),
  };
}

export const anilist: Provider<'anilist'> = async (s: AnilistSettings, mediaType, ctx) => {
  const index = await loadAnimeIds(ctx.datasets, ctx.signal);
  const out: FetchedItem[] = [];
  const add = (media: unknown) => {
    const e = anilistEntry(media);
    if (e.id !== null) push(out, mediaType, { ...e, ids: index.anilist(e.id) });
  };

  if (s.source === 'user') {
    const data = await anilistQuery(
      ctx,
      `query ($user: String, $status: [MediaListStatus]) {
        MediaListCollection(userName: $user, type: ANIME, status_in: $status) { lists { entries { media { ${MEDIA_FIELDS} } } } }
      }`,
      { user: s.username, status: s.statuses.map((st) => ANILIST_STATUS[st]) },
    );
    for (const list of asArray(asRecord(data['MediaListCollection'])?.['lists'])) {
      for (const entry of asArray(asRecord(list)?.['entries'])) {
        add(asRecord(entry)?.['media']);
        if (out.length >= s.limit) return out;
      }
    }
    return out;
  }

  const now = currentSeason(ctx.now());
  const seasonal = s.source === 'seasonal';
  for (let page = 1; page <= 20 && out.length < s.limit; page++) {
    const data = await anilistQuery(
      ctx,
      `query ($page: Int, $sort: [MediaSort], $season: MediaSeason, $year: Int) {
        Page(page: $page, perPage: 50) { pageInfo { hasNextPage } media(type: ANIME, sort: $sort, season: $season, seasonYear: $year, isAdult: false) { ${MEDIA_FIELDS} } }
      }`,
      {
        page,
        sort: [ANILIST_SORT[s.source]],
        ...(seasonal ? { season: (s.season ?? now.season).toUpperCase(), year: s.seasonYear ?? now.year } : {}),
      },
    );
    const pageData = asRecord(data['Page']);
    for (const media of asArray(pageData?.['media'])) {
      add(media);
      if (out.length >= s.limit) break;
    }
    if (asRecord(pageData?.['pageInfo'])?.['hasNextPage'] !== true) break;
  }
  return out;
};

// ---- MyAnimeList ------------------------------------------------------------------------

export const MAL_BASE = 'https://api.myanimelist.net/v2';
const MAL_FIELDS = 'media_type,start_season,start_date,alternative_titles';

function malEntry(node: unknown) {
  const n = asRecord(node);
  const alt = asRecord(n?.['alternative_titles']);
  return {
    id: int(n?.['id']),
    kind: animeKind(str(n?.['media_type'])),
    title: str(alt?.['en']) ?? str(n?.['title']),
    year: int(asRecord(n?.['start_season'])?.['year']) ?? yearOf(str(n?.['start_date'])),
  };
}

export const myAnimeList: Provider<'myAnimeList'> = async (s: MyAnimeListSettings, mediaType, ctx) => {
  const index = await loadAnimeIds(ctx.datasets, ctx.signal);
  const headers = { 'X-MAL-CLIENT-ID': s.clientId, 'User-Agent': USER_AGENT };
  const out: FetchedItem[] = [];
  const walk = async (first: string, status?: string) => {
    let next: string | null = first;
    for (let page = 0; next && page < 20 && out.length < s.limit; page++) {
      const body = asRecord(await getJson(ctx, 'MyAnimeList', next, { headers }));
      for (const row of asArray(body?.['data'])) {
        const r = asRecord(row);
        if (status && str(asRecord(r?.['list_status'])?.['status']) !== status) continue;
        const e = malEntry(r?.['node']);
        if (e.id !== null) push(out, mediaType, { ...e, ids: index.mal(e.id) });
        if (out.length >= s.limit) return;
      }
      next = str(asRecord(body?.['paging'])?.['next']);
    }
  };

  if (s.source === 'user') {
    const user = encodeURIComponent(s.username!);
    for (const status of s.statuses) {
      const url = new URL(`${MAL_BASE}/users/${user}/animelist`);
      url.searchParams.set('status', status);
      url.searchParams.set('fields', `list_status,${MAL_FIELDS}`);
      url.searchParams.set('limit', '1000');
      url.searchParams.set('nsfw', 'false');
      await walk(url.toString(), status);
    }
    return out;
  }
  if (s.source === 'seasonal') {
    const now = currentSeason(ctx.now());
    const url = new URL(`${MAL_BASE}/anime/season/${s.seasonYear ?? now.year}/${s.season ?? now.season}`);
    url.searchParams.set('sort', 'anime_num_list_users');
    url.searchParams.set('fields', MAL_FIELDS);
    url.searchParams.set('limit', '500');
    await walk(url.toString());
    return out;
  }
  const url = new URL(`${MAL_BASE}/anime/ranking`);
  url.searchParams.set('ranking_type', s.rankingType);
  url.searchParams.set('fields', MAL_FIELDS);
  url.searchParams.set('limit', '500');
  await walk(url.toString());
  return out;
};

// ---- Kitsu ------------------------------------------------------------------------------

export const KITSU_BASE = 'https://kitsu.app/api/edge';
const KITSU_HEADERS = { Accept: 'application/vnd.api+json', 'User-Agent': USER_AGENT };

/** MAL id from an anime's included mappings (`myanimelist/anime`). */
function kitsuMalId(anime: Record<string, unknown> | null, included: Map<string, Record<string, unknown>>): number | null {
  for (const ref of asArray(asRecord(asRecord(anime?.['relationships'])?.['mappings'])?.['data'])) {
    const id = str(asRecord(ref)?.['id']);
    const mapping = id ? included.get(`mappings:${id}`) : undefined;
    const attrs = asRecord(mapping?.['attributes']);
    if (str(attrs?.['externalSite']) === 'myanimelist/anime') return int(attrs?.['externalId']);
  }
  return null;
}

function kitsuEntry(anime: Record<string, unknown> | null, included: Map<string, Record<string, unknown>>) {
  const a = asRecord(anime?.['attributes']);
  const titles = asRecord(a?.['titles']);
  return {
    malId: kitsuMalId(anime, included),
    kind: animeKind(str(a?.['subtype'])),
    title: str(titles?.['en']) ?? str(a?.['canonicalTitle']),
    year: yearOf(str(a?.['startDate'])),
  };
}

function includedMap(body: Record<string, unknown> | null): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const raw of asArray(body?.['included'])) {
    const r = asRecord(raw);
    const type = str(r?.['type']);
    const id = str(r?.['id']);
    if (r && type && id) map.set(`${type}:${id}`, r);
  }
  return map;
}

export const kitsu: Provider<'kitsu'> = async (s: KitsuSettings, mediaType, ctx) => {
  const index = await loadAnimeIds(ctx.datasets, ctx.signal);
  const out: FetchedItem[] = [];
  const addAnime = (anime: Record<string, unknown> | null, included: Map<string, Record<string, unknown>>) => {
    const e = kitsuEntry(anime, included);
    push(out, mediaType, { ...e, ids: e.malId !== null ? index.mal(e.malId) : undefined });
  };

  if (s.source === 'trending') {
    // /trending does not take `include`, so mappings come from a second request by id.
    const trending = asRecord(await getJson(ctx, 'Kitsu', `${KITSU_BASE}/trending/anime?limit=20`, { headers: KITSU_HEADERS }));
    const ids = asArray(trending?.['data'])
      .map((r) => str(asRecord(r)?.['id']))
      .filter((id): id is string => id !== null);
    if (!ids.length) return out;
    const url = new URL(`${KITSU_BASE}/anime`);
    url.searchParams.set('filter[id]', ids.join(','));
    url.searchParams.set('include', 'mappings');
    url.searchParams.set('page[limit]', '20');
    const body = asRecord(await getJson(ctx, 'Kitsu', url.toString(), { headers: KITSU_HEADERS }));
    const included = includedMap(body);
    const byId = new Map(asArray(body?.['data']).map((r) => [str(asRecord(r)?.['id']), asRecord(r)] as const));
    for (const id of ids) {
      addAnime(byId.get(id) ?? null, included);
      if (out.length >= s.limit) break;
    }
    return out;
  }

  const users = new URL(`${KITSU_BASE}/users`);
  users.searchParams.set('filter[slug]', s.username!);
  let user = asRecord(asArray(asRecord(await getJson(ctx, 'Kitsu', users.toString(), { headers: KITSU_HEADERS }))?.['data'])[0]);
  if (!user) {
    // Older accounts have no slug; fall back to the display name.
    const byName = new URL(`${KITSU_BASE}/users`);
    byName.searchParams.set('filter[name]', s.username!);
    user = asRecord(asArray(asRecord(await getJson(ctx, 'Kitsu', byName.toString(), { headers: KITSU_HEADERS }))?.['data'])[0]);
  }
  const userId = str(user?.['id']);
  if (!userId) throw new ImportListFetchError('not-found', `Kitsu has no user "${s.username}"`);

  const first = new URL(`${KITSU_BASE}/library-entries`);
  first.searchParams.set('filter[userId]', userId);
  first.searchParams.set('filter[kind]', 'anime');
  first.searchParams.set('filter[status]', s.statuses.join(','));
  first.searchParams.set('include', 'anime,anime.mappings');
  first.searchParams.set('page[limit]', '500');
  let next: string | null = first.toString();
  for (let page = 0; next && page < 20 && out.length < s.limit; page++) {
    const body = asRecord(await getJson(ctx, 'Kitsu', next, { headers: KITSU_HEADERS }));
    const included = includedMap(body);
    for (const entry of asArray(body?.['data'])) {
      const ref = asRecord(asRecord(asRecord(asRecord(entry)?.['relationships'])?.['anime'])?.['data']);
      const id = str(ref?.['id']);
      addAnime(id ? (included.get(`anime:${id}`) ?? null) : null, included);
      if (out.length >= s.limit) break;
    }
    next = str(asRecord(body?.['links'])?.['next']);
  }
  return out;
};
