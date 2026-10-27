import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Test-only: tiny SQLite databases shaped like each upstream app's schema (the real table
// and column names, a handful of rows). Values are plain fixture data.

type Row = Record<string, unknown>;

function open(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  return new Database(path);
}

function insert(db: Database.Database, table: string, row: Row): void {
  const cols = Object.keys(row);
  const values = cols.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });
  db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...values);
}

function table(db: Database.Database, name: string, columns: string[]): void {
  db.exec(`CREATE TABLE "${name}" (${columns.map((c) => (c === 'Id' || c === 'id' ? `"${c}" INTEGER PRIMARY KEY` : `"${c}"`)).join(', ')})`);
}

// ---- shared arr infrastructure -----------------------------------------------------------

function arrInfrastructure(db: Database.Database, app: 'sonarr' | 'radarr'): void {
  table(db, 'VersionInfo', ['Version', 'AppliedOn', 'Description']);
  insert(db, 'VersionInfo', { Version: app === 'sonarr' ? 214 : 240 });
  table(db, 'Tags', ['Id', 'Label']);
  insert(db, 'Tags', { Id: 1, Label: 'anime' });
  insert(db, 'Tags', { Id: 2, Label: '4K' });
  table(db, 'RootFolders', ['Id', 'Path']);
  insert(db, 'RootFolders', { Id: 1, Path: app === 'sonarr' ? '/tv' : '/movies' });
  table(db, 'CustomFormats', ['Id', 'Name', 'Specifications', 'IncludeCustomFormatWhenRenaming']);
  insert(db, 'CustomFormats', {
    Id: 1,
    Name: 'x265',
    IncludeCustomFormatWhenRenaming: 0,
    Specifications: [{ type: 'ReleaseTitleSpecification', body: { name: 'x265', value: '[xh]\\.?265', negate: false, required: true } }],
  });
  insert(db, 'CustomFormats', {
    Id: 2,
    Name: 'Weird',
    IncludeCustomFormatWhenRenaming: 1,
    Specifications: [
      { type: 'SourceSpecification', body: { name: 'WEB', value: app === 'sonarr' ? 3 : 7, negate: false, required: false } },
      { type: 'FutureMagicSpecification', body: { name: 'magic', value: 1 } },
    ],
  });
  table(db, 'QualityProfiles', ['Id', 'Name', 'Cutoff', 'Items', 'UpgradeAllowed', 'FormatItems', 'MinFormatScore', 'CutoffFormatScore', 'MinUpgradeFormatScore', 'Language']);
  insert(db, 'QualityProfiles', {
    Id: 1,
    Name: 'HD-1080p',
    Cutoff: 1000,
    UpgradeAllowed: 1,
    Items: [
      { quality: 1, items: [], allowed: false },
      { id: 1000, name: 'WEB 1080p', items: [{ quality: 3, items: [], allowed: true }, { quality: 15, items: [], allowed: true }], allowed: true },
      { quality: 7, items: [], allowed: true },
      ...(app === 'sonarr' ? [{ quality: 11, items: [], allowed: false }] : []),
    ],
    FormatItems: [{ format: 1, score: 100 }, { format: 2, score: -10 }, { format: 3, score: 0 }],
    MinFormatScore: 0,
    CutoffFormatScore: 100,
    MinUpgradeFormatScore: 1,
    Language: app === 'radarr' ? 1 : null,
  });
  insert(db, 'QualityProfiles', { Id: 2, Name: 'Any', Cutoff: 1, UpgradeAllowed: 0, Items: [{ quality: 1, items: [], allowed: true }], FormatItems: [] });
  table(db, 'DelayProfiles', ['Id', 'EnableUsenet', 'EnableTorrent', 'PreferredProtocol', 'UsenetDelay', 'TorrentDelay', 'Order', 'Tags', 'BypassIfHighestQuality', 'BypassIfAboveCustomFormatScore', 'MinimumCustomFormatScore']);
  insert(db, 'DelayProfiles', { Id: 1, EnableUsenet: 1, EnableTorrent: 1, PreferredProtocol: 2, UsenetDelay: 60, TorrentDelay: 0, Order: 2147483647, Tags: [], BypassIfHighestQuality: 1 });
  insert(db, 'DelayProfiles', { Id: 2, EnableUsenet: 1, EnableTorrent: 0, PreferredProtocol: 1, UsenetDelay: 120, TorrentDelay: 30, Order: 1, Tags: [1] });
  table(db, 'ReleaseProfiles', ['Id', 'Name', 'Enabled', 'Required', 'Ignored', 'IndexerId', 'Tags']);
  insert(db, 'ReleaseProfiles', { Id: 1, Name: 'No CAM', Enabled: 1, Required: [], Ignored: ['cam', 'telesync'], IndexerId: 2, Tags: [] });
  table(db, 'Indexers', ['Id', 'Name', 'Implementation', 'Settings', 'ConfigContract', 'EnableRss', 'EnableAutomaticSearch', 'EnableInteractiveSearch', 'Priority', 'Tags', 'DownloadClientId']);
  insert(db, 'Indexers', {
    Id: 1,
    Name: 'NZBgeek',
    Implementation: 'Newznab',
    ConfigContract: 'NewznabSettings',
    Settings: { baseUrl: 'https://api.nzbgeek.info', apiPath: '/api', apiKey: 'geek-key', categories: [5030, 5040], animeCategories: [] },
    EnableRss: 1,
    EnableAutomaticSearch: 1,
    EnableInteractiveSearch: 1,
    Priority: 10,
    Tags: [],
    DownloadClientId: 0,
  });
  insert(db, 'Indexers', {
    Id: 2,
    Name: 'Jackett 1337x',
    Implementation: 'Torznab',
    ConfigContract: 'TorznabSettings',
    Settings: { baseUrl: 'http://jackett:9117/api/v2.0/indexers/1337x/results/torznab/', apiPath: '/api', apiKey: 'jk', categories: [5000], minimumSeeders: 5, seedCriteria: { seedRatio: 1.5, seedTime: 60 } },
    EnableRss: 0,
    EnableAutomaticSearch: 1,
    EnableInteractiveSearch: 1,
    Priority: 99,
    Tags: [2],
    DownloadClientId: 1,
  });
  insert(db, 'Indexers', { Id: 3, Name: 'IPT', Implementation: 'IPTorrents', Settings: { baseUrl: 'https://iptorrents.com/rss' }, Priority: 25, Tags: [] });
  table(db, 'DownloadClients', ['Id', 'Enable', 'Name', 'Implementation', 'Settings', 'ConfigContract', 'Priority', 'RemoveCompletedDownloads', 'RemoveFailedDownloads', 'Tags']);
  insert(db, 'DownloadClients', {
    Id: 1,
    Enable: 1,
    Name: 'qBit',
    Implementation: 'QBittorrent',
    Settings: {
      host: 'qbit',
      port: 8080,
      username: 'admin',
      password: 'secret',
      [app === 'sonarr' ? 'tvCategory' : 'movieCategory']: app === 'sonarr' ? 'tv-sonarr' : 'radarr',
      [app === 'sonarr' ? 'recentTvPriority' : 'recentMoviePriority']: 1,
      initialState: 2,
      contentLayout: 2,
    },
    Priority: 1,
    RemoveCompletedDownloads: 1,
    RemoveFailedDownloads: 1,
    Tags: [2],
  });
  insert(db, 'DownloadClients', { Id: 2, Enable: 1, Name: 'Blackhole', Implementation: 'TorrentBlackhole', Settings: { torrentFolder: '/bh', watchFolder: '/bh/done' }, Priority: 1, Tags: [] });
  insert(db, 'DownloadClients', {
    Id: 3,
    Enable: 1,
    Name: 'SAB',
    Implementation: 'Sabnzbd',
    Settings: { host: 'sab', port: 8085, apiKey: 'sab-key', [app === 'sonarr' ? 'tvCategory' : 'movieCategory']: 'tv', [app === 'sonarr' ? 'recentTvPriority' : 'recentMoviePriority']: 1, [app === 'sonarr' ? 'olderTvPriority' : 'olderMoviePriority']: -100 },
    Priority: 2,
    Tags: [],
  });
  table(db, 'RemotePathMappings', ['Id', 'Host', 'RemotePath', 'LocalPath']);
  insert(db, 'RemotePathMappings', { Id: 1, Host: 'qbit', RemotePath: '/downloads/', LocalPath: '/data/downloads/' });
  table(db, 'Notifications', [
    'Id', 'Name', 'OnGrab', 'OnDownload', 'Settings', 'Implementation', 'ConfigContract', 'OnUpgrade', 'Tags', 'OnRename', 'OnHealthIssue', 'IncludeHealthWarnings',
    'OnSeriesDelete', 'OnEpisodeFileDelete', 'OnMovieDelete', 'OnMovieFileDelete', 'OnMovieAdded', 'OnSeriesAdd', 'OnApplicationUpdate', 'OnManualInteractionRequired', 'OnHealthRestored',
  ]);
  insert(db, 'Notifications', {
    Id: 1,
    Name: 'Discord',
    Implementation: 'Discord',
    Settings: { webHookUrl: 'https://discord.com/api/webhooks/1/abc', username: 'Arr', grabFields: [0, 1] },
    OnGrab: 1,
    OnDownload: 1,
    OnUpgrade: 1,
    OnHealthIssue: 1,
    [app === 'sonarr' ? 'OnSeriesDelete' : 'OnMovieDelete']: 1,
    [app === 'sonarr' ? 'OnEpisodeFileDelete' : 'OnMovieFileDelete']: 1,
    Tags: [],
  });
  insert(db, 'Notifications', { Id: 2, Name: 'Bad Pushover', Implementation: 'Pushover', Settings: { apiKey: 'short', userKey: 'short' }, OnGrab: 1, Tags: [] });
  insert(db, 'Notifications', { Id: 3, Name: 'Slack', Implementation: 'Slack', Settings: { webHookUrl: 'https://hooks.slack.com/x' }, Tags: [] });
  table(db, 'ImportLists', ['Id', 'Name', 'Implementation', 'Settings', 'ConfigContract', 'EnableAutomaticAdd', 'Enabled', 'RootFolderPath', 'ShouldMonitor', 'Monitor', 'QualityProfileId', 'Tags', 'SeriesType', 'SeasonFolder', 'MinimumAvailability', 'SearchOnAdd']);
  insert(db, 'ImportLists', {
    Id: 1,
    Name: 'IMDb List',
    Implementation: app === 'sonarr' ? 'ImdbListImport' : 'IMDbListImport',
    Settings: { listId: 'ls12345' },
    EnableAutomaticAdd: 1,
    Enabled: 1,
    RootFolderPath: app === 'sonarr' ? '/tv' : '/movies',
    ShouldMonitor: 1,
    Monitor: 0,
    QualityProfileId: 1,
    Tags: [1],
    SeriesType: 0,
    SeasonFolder: 1,
    MinimumAvailability: 3,
  });
  insert(db, 'ImportLists', { Id: 2, Name: 'Trakt Watchlist', Implementation: 'TraktUserImport', Settings: { accessToken: 'x' }, RootFolderPath: '/tv', QualityProfileId: 1, Tags: [] });
  table(db, 'Config', ['Id', 'Key', 'Value']);
  insert(db, 'Config', { Id: 1, Key: 'recyclebin', Value: '/data/recycle' });
  insert(db, 'Config', { Id: 2, Key: 'recyclebincleanupdays', Value: '14' });
  insert(db, 'Config', { Id: 3, Key: 'copyusinghardlinks', Value: 'False' });
  insert(db, 'Config', { Id: 4, Key: 'episodetitlerequired', Value: 'BulkSeasonReleases' });
  insert(db, 'Config', { Id: 5, Key: 'extrafileextensions', Value: 'srt,.nfo' });
}

export function makeSonarrDb(path: string): void {
  const db = open(path);
  arrInfrastructure(db, 'sonarr');
  table(db, 'NamingConfig', [
    'Id', 'MultiEpisodeStyle', 'RenameEpisodes', 'StandardEpisodeFormat', 'DailyEpisodeFormat', 'SeasonFolderFormat', 'SeriesFolderFormat', 'AnimeEpisodeFormat',
    'ReplaceIllegalCharacters', 'SpecialsFolderFormat', 'ColonReplacementFormat', 'CustomColonReplacementFormat',
  ]);
  insert(db, 'NamingConfig', {
    Id: 1,
    MultiEpisodeStyle: 4,
    RenameEpisodes: 1,
    StandardEpisodeFormat: '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full} {Series TitleSlug}',
    DailyEpisodeFormat: '{Series Title} - {Air-Date} - {Episode Title}',
    SeasonFolderFormat: 'Season {season:00}',
    SeriesFolderFormat: '{Series TitleYear}',
    AnimeEpisodeFormat: '{Series Title} - {absolute:000} - {Episode Title}',
    ReplaceIllegalCharacters: 1,
    SpecialsFolderFormat: 'Specials',
    ColonReplacementFormat: 1,
  });
  table(db, 'Series', [
    'Id', 'TvdbId', 'TmdbId', 'ImdbId', 'Title', 'CleanTitle', 'SortTitle', 'Status', 'Overview', 'Images', 'Path', 'Monitored', 'QualityProfileId', 'SeasonFolder',
    'Runtime', 'SeriesType', 'Network', 'UseSceneNumbering', 'FirstAired', 'Year', 'Seasons', 'Ratings', 'Genres', 'Certification', 'Tags', 'Added', 'OriginalLanguage', 'MonitorNewItems',
  ]);
  insert(db, 'Series', {
    Id: 1,
    TvdbId: 81189,
    TmdbId: 1396,
    ImdbId: 'tt0903747',
    Title: 'Breaking Bad',
    Status: 1,
    Overview: 'A teacher turns to crime.',
    Images: [{ coverType: 'poster', remoteUrl: 'https://artworks.thetvdb.com/p.jpg', url: '/MediaCover/1/poster.jpg' }, { coverType: 'unknownType', url: 'x' }],
    Path: '/tv/Breaking Bad',
    Monitored: 1,
    QualityProfileId: 1,
    SeasonFolder: 1,
    Runtime: 47,
    SeriesType: 0,
    Network: 'AMC',
    FirstAired: '2008-01-20 00:00:00Z',
    Year: 2008,
    Seasons: [{ seasonNumber: 0, monitored: false }, { seasonNumber: 1, monitored: true }],
    Ratings: { votes: 10, value: 9.5 },
    Genres: ['Drama', 'Crime'],
    Certification: 'TV-MA',
    Tags: [2],
    Added: '2020-01-01 10:00:00Z',
    OriginalLanguage: 1,
    MonitorNewItems: 0,
  });
  insert(db, 'Series', { Id: 2, TvdbId: 70000, TmdbId: 0, Title: 'Old Show', Status: 1, Path: '/tv/Old Show', Monitored: 1, QualityProfileId: 2, Tags: [], Seasons: [], Year: 1999 });
  insert(db, 'Series', { Id: 3, TvdbId: 80000, TmdbId: 999, Title: 'Anime X', Status: 0, Path: '/tv/Anime X', Monitored: 0, QualityProfileId: 2, SeriesType: 2, SeasonFolder: 0, Tags: [1], Seasons: [{ seasonNumber: 1, monitored: true }], Year: 2021, MonitorNewItems: 1 });
  table(db, 'Episodes', ['Id', 'SeriesId', 'SeasonNumber', 'EpisodeNumber', 'Title', 'Overview', 'EpisodeFileId', 'AirDate', 'AirDateUtc', 'Monitored', 'AbsoluteEpisodeNumber', 'Runtime']);
  insert(db, 'Episodes', { Id: 1, SeriesId: 1, SeasonNumber: 1, EpisodeNumber: 1, Title: 'Pilot', EpisodeFileId: 1, AirDate: '2008-01-20', AirDateUtc: '2008-01-21 03:00:00Z', Monitored: 1 });
  insert(db, 'Episodes', { Id: 2, SeriesId: 1, SeasonNumber: 1, EpisodeNumber: 2, Title: "Cat's in the Bag...", EpisodeFileId: 1, AirDate: '2008-01-27', Monitored: 1 });
  insert(db, 'Episodes', { Id: 3, SeriesId: 1, SeasonNumber: 1, EpisodeNumber: 3, Title: '...And the Bag', EpisodeFileId: 0, AirDate: '2008-02-10', Monitored: 1 });
  insert(db, 'Episodes', { Id: 4, SeriesId: 1, SeasonNumber: 0, EpisodeNumber: 1, Title: 'Special', EpisodeFileId: 0, Monitored: 0 });
  insert(db, 'Episodes', { Id: 5, SeriesId: 3, SeasonNumber: 1, EpisodeNumber: 1, Title: 'Start', EpisodeFileId: 2, Monitored: 1, AbsoluteEpisodeNumber: 1 });
  insert(db, 'Episodes', { Id: 6, SeriesId: 2, SeasonNumber: 1, EpisodeNumber: 1, Title: 'Old', EpisodeFileId: 0, Monitored: 1 });
  table(db, 'EpisodeFiles', ['Id', 'SeriesId', 'SeasonNumber', 'RelativePath', 'Size', 'DateAdded', 'SceneName', 'Quality', 'MediaInfo', 'ReleaseGroup', 'Languages']);
  insert(db, 'EpisodeFiles', {
    Id: 1,
    SeriesId: 1,
    SeasonNumber: 1,
    RelativePath: 'Season 01/Breaking.Bad.S01E01E02.1080p.WEB-DL.mkv',
    Size: 3_000_000_000,
    DateAdded: '2021-02-03 04:05:06Z',
    SceneName: 'Breaking.Bad.S01E01E02.1080p.WEB-DL-NTb',
    Quality: { quality: 3, revision: { version: 2, real: 0, isRepack: true } },
    MediaInfo: { videoCodec: 'h264', audioCodec: 'EAC3', audioChannels: 5.1, width: 1920, height: 1080, runTime: '00:47:10.5000000', audioLanguages: 'eng/spa', subtitles: ['eng'] },
    ReleaseGroup: 'NTb',
    Languages: [1],
  });
  insert(db, 'EpisodeFiles', { Id: 2, SeriesId: 3, SeasonNumber: 1, RelativePath: 'Anime.X.S01E01.mkv', Size: 100, DateAdded: '2022-01-01 00:00:00Z', Quality: { quality: 20, revision: { version: 1 } }, Languages: [8] });
  table(db, 'History', ['Id', 'EpisodeId', 'SeriesId', 'SourceTitle', 'Date', 'Quality', 'Data', 'EventType', 'DownloadId', 'Languages']);
  insert(db, 'History', { Id: 1, EpisodeId: 1, SeriesId: 1, SourceTitle: 'Breaking.Bad.S01E01E02.1080p.WEB-DL-NTb', Date: '2021-02-03 03:00:00Z', Quality: { quality: 3 }, Data: { Indexer: 'NZBgeek', DownloadClient: 'qBit' }, EventType: 1, DownloadId: 'HASH1', Languages: [1] });
  insert(db, 'History', { Id: 2, EpisodeId: 1, SeriesId: 1, SourceTitle: 'Breaking.Bad.S01E01E02.1080p.WEB-DL-NTb', Date: '2021-02-03 04:05:06Z', Quality: { quality: 3 }, Data: {}, EventType: 3, DownloadId: 'HASH1', Languages: [1] });
  insert(db, 'History', { Id: 3, EpisodeId: 1, SeriesId: 1, SourceTitle: 'deleted', Date: '2021-02-04 00:00:00Z', Quality: { quality: 3 }, Data: {}, EventType: 5 });
  insert(db, 'History', { Id: 4, EpisodeId: 6, SeriesId: 2, SourceTitle: 'Old.Show.S01E01', Date: '2021-02-05 00:00:00Z', Quality: { quality: 1 }, Data: {}, EventType: 1 });
  // Sonarr writes one row per episode for a multi-episode or season release: same title, same moment.
  insert(db, 'History', { Id: 5, EpisodeId: 2, SeriesId: 1, SourceTitle: 'Breaking.Bad.S01E01E02.1080p.WEB-DL-NTb', Date: '2021-02-03 03:00:00Z', Quality: { quality: 3 }, Data: { Indexer: 'NZBgeek', DownloadClient: 'qBit' }, EventType: 1, DownloadId: 'HASH1', Languages: [1] });
  table(db, 'Blocklist', ['Id', 'SeriesId', 'EpisodeIds', 'SourceTitle', 'Quality', 'Date', 'PublishedDate', 'Size', 'Protocol', 'Indexer', 'Message', 'TorrentInfoHash', 'Languages', 'IndexerFlags', 'ReleaseType']);
  insert(db, 'Blocklist', {
    Id: 1,
    SeriesId: 1,
    EpisodeIds: [3],
    SourceTitle: 'Breaking.Bad.S01E03.CAM',
    Quality: { quality: 1 },
    Date: '2021-03-01 00:00:00Z',
    PublishedDate: '2021-02-28 00:00:00Z',
    Size: 1234,
    Protocol: 2,
    Indexer: 'Jackett 1337x',
    Message: 'fake',
    TorrentInfoHash: 'ABCDEF',
    Languages: [1],
    IndexerFlags: 17,
    ReleaseType: 1,
  });
  db.close();
}

export function makeRadarrDb(path: string, opts: { legacy?: boolean } = {}): void {
  const db = open(path);
  arrInfrastructure(db, 'radarr');
  table(db, 'NamingConfig', ['Id', 'MultiEpisodeStyle', 'RenameEpisodes', 'StandardMovieFormat', 'MovieFolderFormat', 'ColonReplacementFormat', 'ReplaceIllegalCharacters']);
  insert(db, 'NamingConfig', { Id: 1, RenameEpisodes: 1, StandardMovieFormat: '{Movie Title} ({Release Year}) {edition-{Edition Tags}} {Quality Full}', MovieFolderFormat: '{Movie Title} ({Release Year})', ColonReplacementFormat: 4, ReplaceIllegalCharacters: 1 });
  if (opts.legacy) {
    table(db, 'Movies', ['Id', 'TmdbId', 'ImdbId', 'Title', 'Year', 'Status', 'Path', 'Monitored', 'ProfileId', 'Tags', 'Added', 'MovieFileId', 'MinimumAvailability']);
    insert(db, 'Movies', { Id: 1, TmdbId: 603, ImdbId: 'tt0133093', Title: 'The Matrix', Year: 1999, Status: 3, Path: '/movies/The Matrix (1999)', Monitored: 1, ProfileId: 1, Tags: [], MovieFileId: 0, MinimumAvailability: 3 });
  } else {
    table(db, 'MovieMetadata', ['Id', 'TmdbId', 'ImdbId', 'Images', 'Genres', 'Title', 'SortTitle', 'CleanTitle', 'OriginalTitle', 'OriginalLanguage', 'Status', 'Runtime', 'InCinemas', 'PhysicalRelease', 'DigitalRelease', 'Year', 'Ratings', 'Certification', 'Studio', 'Overview', 'CollectionTmdbId', 'CollectionTitle']);
    insert(db, 'MovieMetadata', {
      Id: 10,
      TmdbId: 603,
      ImdbId: 'tt0133093',
      Images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/p.jpg' }],
      Genres: ['Action', 'Science Fiction'],
      Title: 'The Matrix',
      OriginalTitle: 'The Matrix',
      OriginalLanguage: 1,
      Status: 3,
      Runtime: 136,
      InCinemas: '1999-03-30 00:00:00Z',
      DigitalRelease: '2001-01-01 00:00:00Z',
      Year: 1999,
      Ratings: { imdb: { votes: 100, value: 8.7, type: 0 }, tmdb: { votes: 50, value: 8.2 } },
      Certification: 'R',
      Studio: 'Warner Bros.',
      Overview: 'Neo.',
      CollectionTmdbId: 2344,
      CollectionTitle: 'The Matrix Collection',
    });
    insert(db, 'MovieMetadata', { Id: 11, TmdbId: 0, Title: 'Unmatched', Year: 2000, Status: 0 });
    table(db, 'Movies', ['Id', 'Path', 'Monitored', 'QualityProfileId', 'Added', 'Tags', 'MovieFileId', 'MinimumAvailability', 'MovieMetadataId']);
    insert(db, 'Movies', { Id: 1, Path: '/movies/The Matrix (1999)', Monitored: 1, QualityProfileId: 1, Added: '2020-05-05 00:00:00Z', Tags: [2], MovieFileId: 7, MinimumAvailability: 2, MovieMetadataId: 10 });
    insert(db, 'Movies', { Id: 2, Path: '/movies/Unmatched (2000)', Monitored: 1, QualityProfileId: 2, Tags: [], MovieFileId: 0, MinimumAvailability: 3, MovieMetadataId: 11 });
  }
  table(db, 'MovieFiles', ['Id', 'MovieId', 'Quality', 'Size', 'DateAdded', 'SceneName', 'MediaInfo', 'ReleaseGroup', 'RelativePath', 'Edition', 'Languages']);
  insert(db, 'MovieFiles', { Id: 7, MovieId: 1, Quality: { quality: 30, revision: { version: 1 } }, Size: 30_000_000_000, DateAdded: '2020-05-06 00:00:00Z', ReleaseGroup: 'FGT', RelativePath: 'The.Matrix.1999.Remux.mkv', Edition: "Director's Cut", Languages: [1, 26] });
  table(db, 'Collections', ['Id', 'Title', 'TmdbId', 'Monitored', 'QualityProfileId', 'RootFolderPath', 'SearchOnAdd', 'MinimumAvailability', 'Tags']);
  insert(db, 'Collections', { Id: 1, Title: 'The Matrix Collection', TmdbId: 2344, Monitored: 1, QualityProfileId: 1, RootFolderPath: '/movies', SearchOnAdd: 1, MinimumAvailability: 3, Tags: [] });
  table(db, 'History', ['Id', 'MovieId', 'SourceTitle', 'Date', 'Quality', 'Data', 'EventType', 'DownloadId', 'Languages']);
  insert(db, 'History', { Id: 1, MovieId: 1, SourceTitle: 'The.Matrix.1999.Remux-FGT', Date: '2020-05-06 00:00:00Z', Quality: { quality: 30 }, Data: { indexer: 'NZBgeek' }, EventType: 1, DownloadId: 'D1', Languages: [1] });
  table(db, 'Blocklist', ['Id', 'MovieId', 'SourceTitle', 'Quality', 'Date', 'Protocol', 'Indexer', 'Message', 'TorrentInfoHash', 'Languages', 'IndexerFlags']);
  db.close();
}

export function makeProwlarrDb(path: string, configPath?: string): void {
  const db = open(path);
  table(db, 'VersionInfo', ['Version']);
  insert(db, 'VersionInfo', { Version: 41 });
  table(db, 'Tags', ['Id', 'Label']);
  insert(db, 'Tags', { Id: 1, Label: 'private' });
  table(db, 'Indexers', ['Id', 'Name', 'Implementation', 'Settings', 'ConfigContract', 'Enable', 'Priority', 'Added', 'AppProfileId', 'Tags', 'DownloadClientId']);
  insert(db, 'Indexers', { Id: 1, Name: '1337x', Implementation: 'Cardigann', ConfigContract: 'CardigannSettings', Settings: { definitionFile: '1337x', baseUrl: 'https://1337x.to/', extraFieldData: { sort: 2 } }, Enable: 1, Priority: 25, Tags: [1], AppProfileId: 1 });
  insert(db, 'Indexers', { Id: 2, Name: 'My Newznab', Implementation: 'Newznab', Settings: { baseUrl: 'https://nzb.example', apiPath: '/api', apiKey: 'nk', categories: [2000] }, Enable: 1, Priority: 5, Tags: [] });
  insert(db, 'Indexers', { Id: 3, Name: 'NZBIndex', Implementation: 'NzbIndex', Settings: {}, Enable: 0, Priority: 30, Tags: [] });
  table(db, 'IndexerProxies', ['Id', 'Name', 'Settings', 'Implementation', 'ConfigContract', 'Tags']);
  insert(db, 'IndexerProxies', { Id: 1, Name: 'Flare', Implementation: 'FlareSolverr', Settings: { host: 'http://flaresolverr:8191/', requestTimeout: 60 }, Tags: [1] });
  table(db, 'Applications', ['Id', 'Name', 'Implementation', 'Settings', 'ConfigContract', 'SyncLevel', 'Tags']);
  insert(db, 'Applications', { Id: 1, Name: 'Sonarr', Implementation: 'Sonarr', Settings: { prowlarrUrl: 'http://prowlarr:9696' }, SyncLevel: 2, Tags: [] });
  db.close();
  if (configPath) writeFileSync(configPath, '<Config>\n  <Port>9696</Port>\n  <UrlBase></UrlBase>\n  <ApiKey>prowlarr-key</ApiKey>\n  <BindAddress>*</BindAddress>\n</Config>\n');
}

export function makeBazarrDb(path: string, configPath?: string): void {
  const db = open(path);
  db.exec('CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)');
  insert(db, 'alembic_version', { version_num: 'cee6a710cb71' });
  db.exec('CREATE TABLE table_languages_profiles (profileId INTEGER PRIMARY KEY, cutoff INTEGER, originalFormat INTEGER, items TEXT NOT NULL, name TEXT NOT NULL, mustContain TEXT, mustNotContain TEXT, tag TEXT)');
  insert(db, 'table_languages_profiles', {
    profileId: 1,
    cutoff: 2,
    originalFormat: 0,
    name: 'English + French',
    items: [
      { id: 1, language: 'en', audio_exclude: 'False', hi: 'also', forced: 'False' },
      { id: 2, language: 'fr', audio_exclude: 'True', hi: 'False', forced: 'True' },
      { id: 3, language: 'pb', audio_exclude: 'False', hi: 'True', forced: 'False' },
    ],
    mustContain: ['WEB'],
    mustNotContain: '[]',
    tag: 'subs',
  });
  db.exec('CREATE TABLE table_history (id INTEGER PRIMARY KEY, action INTEGER NOT NULL, description TEXT NOT NULL, language TEXT, provider TEXT, score INTEGER, sonarrEpisodeId INTEGER, sonarrSeriesId INTEGER, subs_id TEXT, subtitles_path TEXT, timestamp DATETIME NOT NULL, video_path TEXT)');
  insert(db, 'table_history', { id: 1, action: 1, description: 'English subtitles downloaded', language: 'en', provider: 'opensubtitlescom', score: 95, sonarrEpisodeId: 1, sonarrSeriesId: 1, subs_id: 's1', subtitles_path: '/tv/Breaking Bad/Season 01/x.en.srt', timestamp: '2021-01-01 10:00:00', video_path: '/tv/Breaking Bad/Season 01/x.mkv' });
  insert(db, 'table_history', { id: 2, action: 3, description: 'English HI subtitles upgraded', language: 'en:hi', provider: 'addic7ed', score: 300, sonarrEpisodeId: 1, sonarrSeriesId: 1, subs_id: 's2', subtitles_path: '/tv/Breaking Bad/Season 01/Breaking.Bad.S01E01E02.1080p.WEB-DL.en.hi.srt', timestamp: '2021-01-05 10:00:00', video_path: '/tv/Breaking Bad/Season 01/Breaking.Bad.S01E01E02.1080p.WEB-DL.mkv' });
  db.exec('CREATE TABLE table_shows (sonarrSeriesId INTEGER PRIMARY KEY, title TEXT, path TEXT, tvdbId INTEGER, imdbId TEXT, profileId INTEGER)');
  insert(db, 'table_shows', { sonarrSeriesId: 1, title: 'Breaking Bad', path: '/tv/Breaking Bad', tvdbId: 81189, imdbId: 'tt0903747', profileId: 1 });
  insert(db, 'table_shows', { sonarrSeriesId: 9, title: 'Not In Library', path: '/tv/Nope', tvdbId: 1, profileId: 1 });
  db.exec('CREATE TABLE table_episodes (sonarrEpisodeId INTEGER PRIMARY KEY, sonarrSeriesId INTEGER, path TEXT, subtitles TEXT)');
  insert(db, 'table_episodes', {
    sonarrEpisodeId: 1,
    sonarrSeriesId: 1,
    path: '/tv/Breaking Bad/Season 01/Breaking.Bad.S01E01E02.1080p.WEB-DL.mkv',
    // Older Bazarr releases store a Python literal.
    subtitles: "[['en', '/tv/Breaking Bad/Season 01/Breaking.Bad.S01E01E02.1080p.WEB-DL.en.srt', 1200], ['fr:forced', None, None], ['de', '/tv/Breaking Bad/Season 01/missing.de.srt', 5]]",
  });
  db.exec('CREATE TABLE table_movies (radarrId INTEGER PRIMARY KEY, title TEXT, path TEXT, tmdbId INTEGER, imdbId TEXT, profileId INTEGER, subtitles TEXT)');
  insert(db, 'table_movies', {
    radarrId: 1,
    title: 'The Matrix',
    path: '/movies/The Matrix (1999)/The.Matrix.1999.Remux.mkv',
    tmdbId: 603,
    imdbId: 'tt0133093',
    profileId: 1,
    subtitles: JSON.stringify([['en:hi', '/movies/The Matrix (1999)/The.Matrix.1999.Remux.en.hi.srt', 3000]]),
  });
  db.exec('CREATE TABLE table_history_movie (id INTEGER PRIMARY KEY, action INTEGER NOT NULL, description TEXT NOT NULL, language TEXT, provider TEXT, radarrId INTEGER, score INTEGER, subs_id TEXT, subtitles_path TEXT, timestamp DATETIME NOT NULL, video_path TEXT)');
  insert(db, 'table_history_movie', { id: 1, action: 1, description: 'French subtitles', language: 'fr', provider: 'addic7ed', radarrId: 1, score: 80, timestamp: '2021-01-02 10:00:00', video_path: '/movies/M/m.mkv' });
  db.exec('CREATE TABLE table_blacklist (id INTEGER PRIMARY KEY, language TEXT, provider TEXT, sonarr_episode_id INTEGER, sonarr_series_id INTEGER, subs_id TEXT, timestamp DATETIME)');
  insert(db, 'table_blacklist', { id: 1, language: 'en', provider: 'podnapisi', sonarr_episode_id: 2, sonarr_series_id: 1, subs_id: 'bad1', timestamp: '2021-01-03 00:00:00' });
  db.close();
  if (configPath) {
    writeFileSync(
      configPath,
      [
        '---',
        'general:',
        '  enabled_providers:',
        '  - opensubtitlescom',
        '  - addic7ed',
        '  - legendasdivx',
        '  use_sonarr: true',
        "  path_mappings: [['/tv', '/data/tv']]",
        '  serie_default_enabled: true',
        '  serie_default_profile: 1',
        'opensubtitlescom:',
        '  username: osuser',
        "  password: 'os pass'",
        '  use_hash: true',
        'addic7ed:',
        '  username: adduser',
        '  password: addpass',
        'podnapisi:',
        '  verify_ssl: true',
        '',
      ].join('\n'),
    );
  }
}

export function makeSeerrDb(path: string, settingsPath?: string): void {
  const db = open(path);
  db.exec('CREATE TABLE migrations (id INTEGER PRIMARY KEY, timestamp BIGINT, name VARCHAR)');
  insert(db, 'migrations', { id: 1, timestamp: 1, name: 'AddOverrideRules1731963944807' });
  db.exec(
    'CREATE TABLE "user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "email" varchar NOT NULL, "username" varchar, "plexId" integer, "plexToken" varchar, "permissions" integer NOT NULL DEFAULT (0), "avatar" varchar NOT NULL, "createdAt" datetime, "updatedAt" datetime, "password" varchar, "userType" integer NOT NULL DEFAULT (1), "plexUsername" varchar, "resetPasswordGuid" varchar, "movieQuotaLimit" integer, "movieQuotaDays" integer, "tvQuotaLimit" integer, "tvQuotaDays" integer, "jellyfinUsername" varchar, "jellyfinAuthToken" varchar, "jellyfinUserId" varchar)',
  );
  insert(db, 'user', { id: 1, email: 'owner@example.com', username: null, plexId: 42, plexToken: 'PLEX-SECRET', permissions: 2, avatar: '/a.png', createdAt: '2022-01-01 00:00:00', password: null, userType: 1, plexUsername: 'owner' });
  insert(db, 'user', { id: 2, email: 'friend@example.com', username: 'friend', permissions: 32, avatar: '/b.png', password: '$2b$12$hash', userType: 2, movieQuotaLimit: 5, movieQuotaDays: 7 });
  db.exec('CREATE TABLE "user_settings" ("id" integer PRIMARY KEY, "locale" varchar NOT NULL DEFAULT (\'\'), "discoverRegion" varchar, "originalLanguage" varchar, "pgpKey" varchar, "discordId" varchar, "pushbulletAccessToken" varchar, "telegramChatId" varchar, "notificationTypes" text, "userId" integer)');
  insert(db, 'user_settings', { id: 1, locale: 'en', discordId: '123', pushbulletAccessToken: 'PB-SECRET', notificationTypes: { email: 2 }, userId: 2 });
  db.exec('CREATE TABLE "media" ("id" integer PRIMARY KEY, "mediaType" varchar NOT NULL, "tmdbId" integer NOT NULL, "tvdbId" integer, "imdbId" varchar, "status" integer NOT NULL DEFAULT (1), "status4k" integer NOT NULL DEFAULT (1))');
  insert(db, 'media', { id: 1, mediaType: 'movie', tmdbId: 603, status: 5 });
  insert(db, 'media', { id: 2, mediaType: 'tv', tmdbId: 1396, tvdbId: 81189, status: 4 });
  db.exec('CREATE TABLE "media_request" ("id" integer PRIMARY KEY, "status" integer NOT NULL, "createdAt" datetime, "updatedAt" datetime, "type" varchar NOT NULL, "mediaId" integer, "requestedById" integer, "modifiedById" integer, "is4k" boolean NOT NULL DEFAULT (0), "serverId" integer, "profileId" integer, "rootFolder" varchar, "languageProfileId" integer, "tags" text, "isAutoRequest" boolean NOT NULL DEFAULT (0))');
  insert(db, 'media_request', { id: 1, status: 2, type: 'movie', mediaId: 1, requestedById: 2, modifiedById: 1, is4k: 0, profileId: 4, rootFolder: '/movies', tags: [1], createdAt: '2023-01-01 00:00:00' });
  insert(db, 'media_request', { id: 2, status: 1, type: 'tv', mediaId: 2, requestedById: 2, is4k: 1, rootFolder: '/tv' });
  db.exec('CREATE TABLE "season_request" ("id" integer PRIMARY KEY, "seasonNumber" integer NOT NULL, "status" integer NOT NULL DEFAULT (1), "requestId" integer)');
  insert(db, 'season_request', { id: 1, seasonNumber: 1, status: 1, requestId: 2 });
  insert(db, 'season_request', { id: 2, seasonNumber: 2, status: 2, requestId: 2 });
  db.exec('CREATE TABLE "issue" ("id" integer PRIMARY KEY, "issueType" integer NOT NULL, "status" integer NOT NULL DEFAULT (1), "problemSeason" integer NOT NULL DEFAULT (0), "problemEpisode" integer NOT NULL DEFAULT (0), "mediaId" integer, "createdById" integer, "modifiedById" integer, "createdAt" datetime)');
  insert(db, 'issue', { id: 1, issueType: 3, status: 1, problemSeason: 1, problemEpisode: 2, mediaId: 2, createdById: 2 });
  db.exec('CREATE TABLE "issue_comment" ("id" integer PRIMARY KEY, "message" text NOT NULL, "userId" integer, "issueId" integer, "createdAt" datetime)');
  insert(db, 'issue_comment', { id: 1, message: 'Subs out of sync', userId: 2, issueId: 1 });
  db.exec('CREATE TABLE "discover_slider" ("id" integer PRIMARY KEY, "type" integer NOT NULL, "order" integer NOT NULL, "isBuiltIn" boolean NOT NULL DEFAULT (0), "enabled" boolean NOT NULL DEFAULT (1), "title" varchar, "data" varchar)');
  insert(db, 'discover_slider', { id: 1, type: 1, order: 0, isBuiltIn: 1, enabled: 1 });
  db.exec('CREATE TABLE "override_rule" ("id" integer PRIMARY KEY, "radarrServiceId" integer, "sonarrServiceId" integer, "users" varchar, "genre" varchar, "language" varchar, "keywords" varchar, "profileId" integer, "rootFolder" varchar, "tags" varchar)');
  insert(db, 'override_rule', { id: 1, sonarrServiceId: 0, genre: '16', profileId: 7, rootFolder: '/anime' });
  db.close();
  if (settingsPath) {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        clientId: 'CLIENT-SECRET',
        main: { apiKey: 'SEERR-API-KEY', applicationTitle: 'Requests', defaultPermissions: 32, defaultQuotas: { movie: { quotaLimit: 3, quotaDays: 7 }, tv: {} }, localLogin: true },
        plex: { name: 'Server', ip: '10.0.0.2', port: 32400 },
      }),
    );
  }
}
