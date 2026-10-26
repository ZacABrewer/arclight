import type { FetchLike } from '../http.js';

// Test-only: a fake HTTP server for Sonarr v4 / Radarr v5 / Prowlarr v1 APIs (an injected
// `fetch`), with responses shaped like those APIs and the same data as the SQLite fixtures in
// test-fixtures.ts, so a plan read through the API can be compared with one read from files.
// Hand-written fixture data; nothing here talks to a network.

type Json = Record<string, unknown>;
export type Route = unknown | ((url: URL) => unknown);

export interface FakeArr {
  fetch: FetchLike;
  /** Paths requested, in order (path + search). */
  calls: string[];
}

/** Serves `routes` (keyed by pathname) when the API key matches; 401 otherwise, 404 for unknown paths. */
export function fakeArr(routes: Record<string, Route>, apiKey: string, header = 'x-api-key'): FakeArr {
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push(url.pathname + url.search);
    const headers = new Headers(init?.headers);
    if (headers.get(header) !== apiKey) return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
    if (!(url.pathname in routes)) return new Response('not found', { status: 404 });
    const route = routes[url.pathname];
    const body = typeof route === 'function' ? (route as (u: URL) => unknown)(url) : route;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, calls };
}

/** `{ page, pageSize, totalRecords, records }` over `records`, honouring page/pageSize. */
export function paged(records: Json[]): (url: URL) => Json {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('pageSize') ?? '10');
    return { page, pageSize, totalRecords: records.length, records: records.slice((page - 1) * pageSize, page * pageSize) };
  };
}

const fields = (o: Json): Array<{ name: string; value: unknown }> => Object.entries(o).map(([name, value]) => ({ name, value }));
const MASK = '********';

function arrCommon(app: 'sonarr' | 'radarr'): Record<string, Route> {
  const tv = app === 'sonarr';
  const p = '/api/v3';
  const q = (id: number, name: string) => ({ id, name, source: 'web', resolution: 1080 });
  return {
    [`${p}/system/status`]: { appName: tv ? 'Sonarr' : 'Radarr', version: tv ? '4.0.10.2544' : '5.14.0.9383' },
    [`${p}/tag`]: [
      { id: 1, label: 'anime' },
      { id: 2, label: '4K' },
    ],
    [`${p}/rootfolder`]: [{ id: 1, path: tv ? '/tv' : '/movies', accessible: true, freeSpace: 1 }],
    [`${p}/customformat`]: [
      {
        id: 1,
        name: 'x265',
        includeCustomFormatWhenRenaming: false,
        specifications: [{ name: 'x265', implementation: 'ReleaseTitleSpecification', negate: false, required: true, fields: [{ name: 'value', value: '[xh]\\.?265' }] }],
      },
      {
        id: 2,
        name: 'Weird',
        includeCustomFormatWhenRenaming: true,
        specifications: [
          { name: 'WEB', implementation: 'SourceSpecification', negate: false, required: false, fields: [{ name: 'value', value: tv ? 3 : 7 }] },
          { name: 'magic', implementation: 'FutureMagicSpecification', negate: false, required: false, fields: [{ name: 'value', value: 1 }] },
        ],
      },
    ],
    [`${p}/qualityprofile`]: [
      {
        id: 1,
        name: 'HD-1080p',
        upgradeAllowed: true,
        cutoff: 1000,
        items: [
          { quality: q(1, 'SDTV'), items: [], allowed: false },
          { id: 1000, name: 'WEB 1080p', items: [{ quality: q(3, 'WEBDL-1080p'), items: [], allowed: true }, { quality: q(15, 'WEBRip-1080p'), items: [], allowed: true }], allowed: true },
          { quality: q(7, 'Bluray-1080p'), items: [], allowed: true },
          ...(tv ? [{ quality: q(11, 'old'), items: [], allowed: false }] : []),
        ],
        formatItems: [
          { format: 1, name: 'x265', score: 100 },
          { format: 2, name: 'Weird', score: -10 },
          { format: 3, name: 'Gone', score: 0 },
        ],
        minFormatScore: 0,
        cutoffFormatScore: 100,
        minUpgradeFormatScore: 1,
        ...(tv ? {} : { language: { id: 1, name: 'English' } }),
      },
      { id: 2, name: 'Any', upgradeAllowed: false, cutoff: 1, items: [{ quality: q(1, 'SDTV'), items: [], allowed: true }], formatItems: [] },
    ],
    [`${p}/delayprofile`]: [
      { id: 1, enableUsenet: true, enableTorrent: true, preferredProtocol: 'torrent', usenetDelay: 60, torrentDelay: 0, bypassIfHighestQuality: true, order: 2147483647, tags: [] },
      { id: 2, enableUsenet: true, enableTorrent: false, preferredProtocol: 'usenet', usenetDelay: 120, torrentDelay: 30, bypassIfHighestQuality: false, order: 1, tags: [1] },
    ],
    [`${p}/releaseprofile`]: [{ id: 1, name: 'No CAM', enabled: true, required: [], ignored: ['cam', 'telesync'], indexerId: 2, tags: [] }],
    [`${p}/indexer`]: [
      {
        id: 1,
        name: 'NZBgeek',
        implementation: 'Newznab',
        configContract: 'NewznabSettings',
        protocol: 'usenet',
        enableRss: true,
        enableAutomaticSearch: true,
        enableInteractiveSearch: true,
        priority: 10,
        downloadClientId: 0,
        tags: [],
        fields: fields({ baseUrl: 'https://api.nzbgeek.info', apiPath: '/api', apiKey: MASK, categories: [5030, 5040], animeCategories: [] }),
      },
      {
        id: 2,
        name: 'Jackett 1337x',
        implementation: 'Torznab',
        protocol: 'torrent',
        enableRss: false,
        enableAutomaticSearch: true,
        enableInteractiveSearch: true,
        priority: 99,
        downloadClientId: 1,
        tags: [2],
        fields: fields({
          baseUrl: 'http://jackett:9117/api/v2.0/indexers/1337x/results/torznab/',
          apiPath: '/api',
          apiKey: 'jk',
          categories: [5000],
          minimumSeeders: 5,
          'seedCriteria.seedRatio': 1.5,
          'seedCriteria.seedTime': 60,
        }),
      },
      { id: 3, name: 'IPT', implementation: 'IPTorrents', protocol: 'torrent', priority: 25, tags: [], fields: fields({ baseUrl: 'https://iptorrents.com/rss' }) },
    ],
    [`${p}/downloadclient`]: [
      {
        id: 1,
        enable: true,
        name: 'qBit',
        implementation: 'QBittorrent',
        protocol: 'torrent',
        priority: 1,
        removeCompletedDownloads: true,
        removeFailedDownloads: true,
        tags: [2],
        fields: fields({
          host: 'qbit',
          port: 8080,
          username: 'admin',
          password: MASK,
          [tv ? 'tvCategory' : 'movieCategory']: tv ? 'tv-sonarr' : 'radarr',
          [tv ? 'recentTvPriority' : 'recentMoviePriority']: 1,
          initialState: 2,
          contentLayout: 2,
        }),
      },
      { id: 2, enable: true, name: 'Blackhole', implementation: 'TorrentBlackhole', protocol: 'torrent', priority: 1, tags: [], fields: fields({ torrentFolder: '/bh', watchFolder: '/bh/done' }) },
      {
        id: 3,
        enable: true,
        name: 'SAB',
        implementation: 'Sabnzbd',
        protocol: 'usenet',
        priority: 2,
        tags: [],
        fields: fields({ host: 'sab', port: 8085, apiKey: 'sab-key', [tv ? 'tvCategory' : 'movieCategory']: 'tv', [tv ? 'recentTvPriority' : 'recentMoviePriority']: 1, [tv ? 'olderTvPriority' : 'olderMoviePriority']: -100 }),
      },
    ],
    [`${p}/remotepathmapping`]: [{ id: 1, host: 'qbit', remotePath: '/downloads/', localPath: '/data/downloads/' }],
    [`${p}/notification`]: [
      {
        id: 1,
        name: 'Discord',
        implementation: 'Discord',
        onGrab: true,
        onDownload: true,
        onUpgrade: true,
        onHealthIssue: true,
        [tv ? 'onSeriesDelete' : 'onMovieDelete']: true,
        [tv ? 'onEpisodeFileDelete' : 'onMovieFileDelete']: true,
        tags: [],
        fields: fields({ webHookUrl: 'https://discord.com/api/webhooks/1/abc', username: 'Arr', grabFields: [0, 1] }),
      },
      { id: 2, name: 'Bad Pushover', implementation: 'Pushover', onGrab: true, tags: [], fields: fields({ apiKey: 'short', userKey: 'short' }) },
      { id: 3, name: 'Slack', implementation: 'Slack', tags: [], fields: fields({ webHookUrl: 'https://hooks.slack.com/x' }) },
    ],
    [`${p}/importlist`]: [
      {
        id: 1,
        name: 'IMDb List',
        implementation: tv ? 'ImdbListImport' : 'IMDbListImport',
        enabled: true,
        enableAutomaticAdd: true,
        ...(tv ? { shouldMonitor: 'all', seriesType: 'standard', seasonFolder: true } : { enableAuto: true, monitor: 'movieOnly', minimumAvailability: 'released' }),
        rootFolderPath: tv ? '/tv' : '/movies',
        qualityProfileId: 1,
        tags: [1],
        fields: fields({ listId: 'ls12345' }),
      },
      { id: 2, name: 'Trakt Watchlist', implementation: 'TraktUserImport', rootFolderPath: '/tv', qualityProfileId: 1, tags: [], fields: fields({ accessToken: MASK }) },
    ],
    [`${p}/config/mediamanagement`]: {
      id: 1,
      recycleBin: '/data/recycle',
      recycleBinCleanupDays: 14,
      copyUsingHardlinks: false,
      episodeTitleRequired: 'bulkSeasonReleases',
      extraFileExtensions: 'srt,.nfo',
    },
  };
}

export function sonarrApiRoutes(): Record<string, Route> {
  const p = '/api/v3';
  const episodes: Record<number, Json[]> = {
    1: [
      { id: 1, seriesId: 1, seasonNumber: 1, episodeNumber: 1, title: 'Pilot', episodeFileId: 1, airDate: '2008-01-20', airDateUtc: '2008-01-21T03:00:00Z', monitored: true, hasFile: true },
      { id: 2, seriesId: 1, seasonNumber: 1, episodeNumber: 2, title: "Cat's in the Bag...", episodeFileId: 1, airDate: '2008-01-27', monitored: true, hasFile: true },
      { id: 3, seriesId: 1, seasonNumber: 1, episodeNumber: 3, title: '...And the Bag', episodeFileId: 0, airDate: '2008-02-10', monitored: true, hasFile: false },
      { id: 4, seriesId: 1, seasonNumber: 0, episodeNumber: 1, title: 'Special', episodeFileId: 0, monitored: false, hasFile: false },
    ],
    2: [{ id: 6, seriesId: 2, seasonNumber: 1, episodeNumber: 1, title: 'Old', episodeFileId: 0, monitored: true }],
    3: [{ id: 5, seriesId: 3, seasonNumber: 1, episodeNumber: 1, title: 'Start', episodeFileId: 2, monitored: true, absoluteEpisodeNumber: 1 }],
  };
  const files: Record<number, Json[]> = {
    1: [
      {
        id: 1,
        seriesId: 1,
        seasonNumber: 1,
        relativePath: 'Season 01/Breaking.Bad.S01E01E02.1080p.WEB-DL.mkv',
        path: '/tv/Breaking Bad/Season 01/Breaking.Bad.S01E01E02.1080p.WEB-DL.mkv',
        size: 3_000_000_000,
        dateAdded: '2021-02-03T04:05:06Z',
        sceneName: 'Breaking.Bad.S01E01E02.1080p.WEB-DL-NTb',
        releaseGroup: 'NTb',
        languages: [{ id: 1, name: 'English' }],
        quality: { quality: { id: 3, name: 'WEBDL-1080p' }, revision: { version: 2, real: 0, isRepack: true } },
        mediaInfo: { videoCodec: 'x264', audioCodec: 'EAC3', audioChannels: 5.1, resolution: '1920x1080', runTime: '47:10', audioLanguages: 'eng/spa', subtitles: 'eng' },
      },
    ],
    2: [],
    3: [{ id: 2, seriesId: 3, seasonNumber: 1, relativePath: 'Anime.X.S01E01.mkv', size: 100, dateAdded: '2022-01-01T00:00:00Z', languages: [{ id: 8, name: 'Japanese' }], quality: { quality: { id: 20 }, revision: { version: 1 } } }],
  };
  const byId = (table: Record<number, Json[]>) => (url: URL) => table[Number(url.searchParams.get('seriesId'))] ?? [];
  return {
    ...arrCommon('sonarr'),
    [`${p}/config/naming`]: {
      renameEpisodes: true,
      replaceIllegalCharacters: true,
      colonReplacementFormat: 1,
      multiEpisodeStyle: 4,
      standardEpisodeFormat: '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full} {Series TitleSlug}',
      dailyEpisodeFormat: '{Series Title} - {Air-Date} - {Episode Title}',
      animeEpisodeFormat: '{Series Title} - {absolute:000} - {Episode Title}',
      seriesFolderFormat: '{Series TitleYear}',
      seasonFolderFormat: 'Season {season:00}',
      specialsFolderFormat: 'Specials',
    },
    [`${p}/series`]: [
      {
        id: 1,
        title: 'Breaking Bad',
        tvdbId: 81189,
        tmdbId: 1396,
        imdbId: 'tt0903747',
        status: 'ended',
        overview: 'A teacher turns to crime.',
        images: [{ coverType: 'poster', remoteUrl: 'https://artworks.thetvdb.com/p.jpg', url: '/MediaCover/1/poster.jpg' }],
        path: '/tv/Breaking Bad',
        monitored: true,
        qualityProfileId: 1,
        seasonFolder: true,
        runtime: 47,
        seriesType: 'standard',
        network: 'AMC',
        useSceneNumbering: false,
        firstAired: '2008-01-20T00:00:00Z',
        year: 2008,
        seasons: [
          { seasonNumber: 0, monitored: false, statistics: {} },
          { seasonNumber: 1, monitored: true, statistics: {} },
        ],
        ratings: { votes: 10, value: 9.5 },
        genres: ['Drama', 'Crime'],
        certification: 'TV-MA',
        tags: [2],
        added: '2020-01-01T10:00:00Z',
        originalLanguage: { id: 1, name: 'English' },
        monitorNewItems: 'all',
      },
      { id: 2, title: 'Old Show', tvdbId: 70000, tmdbId: 0, status: 'ended', path: '/tv/Old Show', monitored: true, qualityProfileId: 2, tags: [], seasons: [], year: 1999 },
      { id: 3, title: 'Anime X', tvdbId: 80000, tmdbId: 999, status: 'continuing', path: '/tv/Anime X', monitored: false, qualityProfileId: 2, seriesType: 'anime', seasonFolder: false, tags: [1], seasons: [{ seasonNumber: 1, monitored: true }], year: 2021, monitorNewItems: 'none' },
    ],
    [`${p}/episode`]: byId(episodes),
    [`${p}/episodefile`]: byId(files),
    [`${p}/history`]: paged([
      { id: 1, episodeId: 1, seriesId: 1, sourceTitle: 'Breaking.Bad.S01E01E02.1080p.WEB-DL-NTb', date: '2021-02-03T03:00:00Z', quality: { quality: { id: 3 } }, data: { indexer: 'NZBgeek', downloadClient: 'qBit' }, eventType: 'grabbed', downloadId: 'HASH1', languages: [{ id: 1, name: 'English' }] },
      { id: 2, episodeId: 1, seriesId: 1, sourceTitle: 'Breaking.Bad.S01E01E02.1080p.WEB-DL-NTb', date: '2021-02-03T04:05:06Z', quality: { quality: { id: 3 } }, data: {}, eventType: 'downloadFolderImported', downloadId: 'HASH1', languages: [{ id: 1, name: 'English' }] },
      { id: 3, episodeId: 1, seriesId: 1, sourceTitle: 'deleted', date: '2021-02-04T00:00:00Z', quality: { quality: { id: 3 } }, data: {}, eventType: 'episodeFileDeleted' },
      { id: 4, episodeId: 6, seriesId: 2, sourceTitle: 'Old.Show.S01E01', date: '2021-02-05T00:00:00Z', quality: { quality: { id: 1 } }, data: {}, eventType: 'grabbed' },
    ]),
    [`${p}/blocklist`]: paged([
      {
        id: 1,
        seriesId: 1,
        episodeIds: [3],
        sourceTitle: 'Breaking.Bad.S01E03.CAM',
        quality: { quality: { id: 1 } },
        date: '2021-03-01T00:00:00Z',
        publishedDate: '2021-02-28T00:00:00Z',
        size: 1234,
        protocol: 'torrent',
        indexer: 'Jackett 1337x',
        message: 'fake',
        torrentInfoHash: 'ABCDEF',
        languages: [{ id: 1, name: 'English' }],
      },
    ]),
  };
}

export function radarrApiRoutes(): Record<string, Route> {
  const p = '/api/v3';
  return {
    ...arrCommon('radarr'),
    [`${p}/config/naming`]: {
      renameMovies: true,
      replaceIllegalCharacters: true,
      colonReplacementFormat: 'smart',
      standardMovieFormat: '{Movie Title} ({Release Year}) {edition-{Edition Tags}} {Quality Full}',
      movieFolderFormat: '{Movie Title} ({Release Year})',
    },
    [`${p}/movie`]: [
      {
        id: 1,
        title: 'The Matrix',
        originalTitle: 'The Matrix',
        originalLanguage: { id: 1, name: 'English' },
        year: 1999,
        tmdbId: 603,
        imdbId: 'tt0133093',
        status: 'released',
        overview: 'Neo.',
        inCinemas: '1999-03-30T00:00:00Z',
        digitalRelease: '2001-01-01T00:00:00Z',
        runtime: 136,
        studio: 'Warner Bros.',
        certification: 'R',
        genres: ['Action', 'Science Fiction'],
        images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/p.jpg' }],
        ratings: { imdb: { votes: 100, value: 8.7, type: 'user' }, tmdb: { votes: 50, value: 8.2, type: 'user' } },
        path: '/movies/The Matrix (1999)',
        monitored: true,
        qualityProfileId: 1,
        minimumAvailability: 'inCinemas',
        added: '2020-05-05T00:00:00Z',
        tags: [2],
        hasFile: true,
        collection: { title: 'The Matrix Collection', tmdbId: 2344 },
        movieFile: {
          id: 7,
          movieId: 1,
          relativePath: 'The.Matrix.1999.Remux.mkv',
          path: '/movies/The Matrix (1999)/The.Matrix.1999.Remux.mkv',
          size: 30_000_000_000,
          dateAdded: '2020-05-06T00:00:00Z',
          releaseGroup: 'FGT',
          edition: "Director's Cut",
          languages: [
            { id: 1, name: 'English' },
            { id: 26, name: 'Hindi' },
          ],
          quality: { quality: { id: 30, name: 'Remux-1080p' }, revision: { version: 1 } },
        },
      },
      { id: 2, title: 'Unmatched', year: 2000, tmdbId: 0, status: 'tba', path: '/movies/Unmatched (2000)', monitored: true, qualityProfileId: 2, minimumAvailability: 'released', tags: [], hasFile: false },
    ],
    [`${p}/collection`]: [{ id: 1, title: 'The Matrix Collection', tmdbId: 2344, monitored: true, qualityProfileId: 1, rootFolderPath: '/movies', searchOnAdd: true, minimumAvailability: 'released', tags: [] }],
    [`${p}/history`]: paged([
      { id: 1, movieId: 1, sourceTitle: 'The.Matrix.1999.Remux-FGT', date: '2020-05-06T00:00:00Z', quality: { quality: { id: 30 } }, data: { indexer: 'NZBgeek' }, eventType: 'grabbed', downloadId: 'D1', languages: [{ id: 1, name: 'English' }] },
    ]),
    [`${p}/blocklist`]: paged([]),
  };
}

export function prowlarrApiRoutes(): Record<string, Route> {
  const p = '/api/v1';
  return {
    [`${p}/system/status`]: { appName: 'Prowlarr', version: '1.24.3.4754' },
    [`${p}/tag`]: [{ id: 1, label: 'private' }],
    [`${p}/indexer`]: [
      {
        id: 1,
        name: '1337x',
        definitionName: '1337x',
        implementation: 'Cardigann',
        configContract: 'CardigannSettings',
        protocol: 'torrent',
        enable: true,
        priority: 25,
        appProfileId: 1,
        tags: [1],
        fields: fields({ definitionFile: '1337x', baseUrl: 'https://1337x.to/', sort: 1, 'torrentBaseSettings.seedRatio': 2, 'torrentBaseSettings.seedTime': 1440, 'baseSettings.queryLimit': 100 }),
      },
      {
        id: 2,
        name: 'My Newznab',
        implementation: 'Newznab',
        protocol: 'usenet',
        enable: true,
        priority: 5,
        tags: [],
        fields: fields({ baseUrl: 'https://nzb.example', apiPath: '/api', apiKey: 'nk', categories: [2000] }),
      },
      {
        id: 4,
        name: 'Secret Tracker',
        definitionName: 'secrettracker',
        implementation: 'Cardigann',
        protocol: 'torrent',
        enable: true,
        priority: 10,
        tags: [],
        fields: fields({ definitionFile: 'secrettracker', baseUrl: 'https://secret.example/', username: 'me', password: MASK }),
      },
    ],
    [`${p}/indexerproxy`]: [
      { id: 1, name: 'Flare', implementation: 'FlareSolverr', tags: [1], fields: fields({ host: 'http://flaresolverr:8191/', requestTimeout: 60 }) },
      { id: 2, name: 'Corp', implementation: 'Http', tags: [], fields: fields({ host: 'proxy.example', port: 3128, username: 'u', password: MASK }) },
      { id: 3, name: 'Old Socks', implementation: 'Socks4', tags: [], fields: fields({ host: 'socks.example', port: 1080 }) },
    ],
    [`${p}/applications`]: [{ id: 1, name: 'Sonarr', implementation: 'Sonarr', syncLevel: 'fullSync', fields: fields({ apiKey: MASK }) }],
  };
}
