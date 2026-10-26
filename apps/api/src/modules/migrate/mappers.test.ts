import { describe, expect, it } from 'vitest';
import { parseArrConfigXml, parseIni, parseSimpleYaml } from './config-files.js';
import { mapCustomFormat, mapSpec } from './mappers/custom-formats.js';
import { mapDownloadClient } from './mappers/download-clients.js';
import { mapImportListSettings, mapMonitorOption } from './mappers/import-lists.js';
import { mapIndexerSettings, prowlarrBaseUrl } from './mappers/indexers.js';
import { mapLanguageId, mapLanguageList, normalizeLanguageCode } from './mappers/languages.js';
import { mapMediaInfo, mapRatings } from './mappers/media.js';
import { mapMediaManagement } from './mappers/media-management.js';
import { mapNamingConfig, translateFormat } from './mappers/naming.js';
import { mapNotification } from './mappers/notifications.js';
import { mapProfileItems, mapQualityId, mapQualityModel } from './mappers/quality.js';
import { joinPath, remapPath } from './paths.js';
import { detectSources } from './sources.js';

const common = { name: 'c', enable: true, priority: 1, removeCompletedDownloads: true, removeFailedDownloads: true };

describe('quality mapping', () => {
  it('maps Sonarr and Radarr ids by name, including renamed remux qualities', () => {
    expect(mapQualityId('sonarr', 20)?.name).toBe('Remux-1080p');
    expect(mapQualityId('sonarr', 22)?.name).toBe('Bluray-576p');
    expect(mapQualityId('radarr', 30)?.name).toBe('Remux-1080p');
    expect(mapQualityId('radarr', 25)?.name).toBe('CAM');
    expect(mapQualityId('radarr', 20)?.name).toBe('Bluray-480p');
  });

  it('drops qualities without an equivalent and keeps revisions', () => {
    expect(mapQualityId('sonarr', 11)).toBeUndefined();
    const model = mapQualityModel('sonarr', { quality: 3, revision: { version: 2, real: 1, isRepack: true } });
    expect(model.quality.name).toBe('WEBDL-1080p');
    expect(model.revision).toEqual({ version: 2, real: 1, isRepack: true });
    expect(mapQualityModel('radarr', { quality: { id: 999 } }).quality.name).toBe('Unknown');
  });

  it('maps profile items with groups and a group cutoff', () => {
    const r = mapProfileItems(
      'sonarr',
      [
        { quality: 1, allowed: false },
        { id: 1001, name: 'WEB', items: [{ quality: 3 }, { quality: 15 }], allowed: true },
        { quality: 11, allowed: true },
      ],
      1001,
    );
    expect(r.items).toEqual([
      { kind: 'quality', qualityId: 1, allowed: false },
      { kind: 'group', id: 1001, name: 'WEB', qualityIds: [3, 16], allowed: true },
    ]);
    expect(r.cutoff).toBe(1001);
    expect(r.dropped).toEqual(['HDTV-480p']);
  });

  it('falls back to the best allowed item when the cutoff was dropped', () => {
    const r = mapProfileItems('sonarr', [{ quality: 1, allowed: true }, { quality: 7, allowed: true }, { quality: 11, allowed: true }], 11);
    expect(r.cutoff).toBe(7);
  });
});

describe('language mapping', () => {
  it('uses the per-app id tables (they diverge after 25)', () => {
    expect(mapLanguageId('sonarr', 26)).toBe('ar');
    expect(mapLanguageId('radarr', 26)).toBe('hi');
    expect(mapLanguageId('sonarr', -2)).toBe('original');
    expect(mapLanguageId('radarr', -1)).toBeUndefined();
  });

  it('reads id lists and object lists, deduplicating', () => {
    expect(mapLanguageList('sonarr', [1, { id: 2, name: 'French' }, 1, { name: 'German' }])).toEqual(['en', 'fr', 'de']);
    expect(normalizeLanguageCode('pb')).toBe('pt');
    expect(normalizeLanguageCode('ger')).toBe('de');
  });
});

describe('custom format specifications', () => {
  it('maps release title specs from the database {type, body} shape', () => {
    const r = mapSpec('sonarr', { type: 'ReleaseTitleSpecification', body: { name: 'x265', value: 'x265', negate: true, required: false } });
    expect(r.spec).toEqual({ implementation: 'releaseTitle', name: 'x265', negate: true, required: false, fields: { pattern: 'x265' } });
  });

  it('maps source values per app and the export {implementation, fields} shape', () => {
    expect(mapSpec('sonarr', { type: 'SourceSpecification', body: { name: 's', value: 3 } }).spec).toMatchObject({ implementation: 'source', fields: { source: 'web' } });
    expect(mapSpec('radarr', { type: 'SourceSpecification', body: { name: 's', value: 7 } }).spec).toMatchObject({ fields: { source: 'web' } });
    const exported = mapSpec('radarr', { implementation: 'SizeSpecification', name: 'big', fields: [{ name: 'min', value: 1 }, { name: 'max', value: 10 }] });
    expect(exported.spec).toMatchObject({ implementation: 'size', fields: { minGb: 1, maxGb: 10 } });
  });

  it('maps indexer flag bits, resolutions and release types', () => {
    expect(mapSpec('radarr', { type: 'IndexerFlagSpecification', body: { name: 'f', value: 2048 } }).spec).toMatchObject({ fields: { flag: 'nuked' } });
    expect(mapSpec('sonarr', { type: 'ResolutionSpecification', body: { name: 'r', value: 2160 } }).spec).toMatchObject({ fields: { resolution: 2160 } });
    expect(mapSpec('sonarr', { type: 'ReleaseTypeSpecification', body: { name: 't', value: 3 } }).spec).toMatchObject({ fields: { releaseType: 'seasonPack' } });
  });

  it('skips unknown specification types with a reason', () => {
    const r = mapCustomFormat('sonarr', 'Odd', false, [{ type: 'FutureMagicSpecification', body: { name: 'magic', value: 1 } }]);
    expect(r.input.specifications).toEqual([]);
    expect(r.dropped[0]).toMatch(/unsupported specification type "futuremagic"/);
  });
});

describe('naming tokens', () => {
  it('keeps known tokens and removes unknown ones', () => {
    const r = translateFormat('{Series Title} - S{season:00}E{episode:00} - {Episode.Title} {Series TitleSlug}');
    expect(r.format).toBe('{Series Title} - S{season:00}E{episode:00} - {Episode.Title}');
    expect(r.removed).toEqual(['{Series TitleSlug}']);
  });

  it('drops wrappers emptied by a removed token and keeps valid wrappers', () => {
    expect(translateFormat('{Movie Title} {edition-{Edition Tags}}').removed).toEqual([]);
    const r = translateFormat('{Movie Title} {tag-{Nope Token}} {Quality Full}');
    expect(r.format).toBe('{Movie Title} {Quality Full}');
  });

  it('maps the Sonarr naming row enums', () => {
    const r = mapNamingConfig('sonarr', { multiepisodestyle: 5, colonreplacementformat: 2, renameepisodes: 1, standardepisodeformat: '{Series Title}' });
    expect(r.values).toMatchObject({ multiEpisodeStyle: 'prefixedRange', colonReplacement: 'spaceDash', renameEpisodes: true, standardEpisodeFormat: '{Series Title}' });
  });
});

describe('download clients', () => {
  it('maps qBittorrent fields and enums', () => {
    const r = mapDownloadClient('sonarr', 'QBittorrent', common, { host: 'qb', port: 8081, tvCategory: 'tv', tvImportedCategory: 'done', recentTvPriority: 1, initialState: 1, contentLayout: 3 });
    expect(r.kind).toBe('native');
    if (r.kind !== 'native') return;
    expect(r.input).toMatchObject({ implementation: 'qbittorrent', settings: { host: 'qb', port: 8081, category: 'tv', postImportCategory: 'done', recentPriority: 'first', olderPriority: 'last', initialState: 'forceStart', contentLayout: 'noSubfolder' } });
  });

  it('maps SABnzbd and NZBGet priorities', () => {
    const sab = mapDownloadClient('radarr', 'Sabnzbd', common, { host: 'sab', apiKey: 'k', movieCategory: 'movies', recentMoviePriority: 2, olderMoviePriority: -2 });
    expect(sab.kind === 'native' && sab.input.settings).toMatchObject({ apiKey: 'k', category: 'movies', recentPriority: 'force', olderPriority: 'paused' });
    const nzb = mapDownloadClient('sonarr', 'Nzbget', common, { host: 'n', recentTvPriority: 50, olderTvPriority: -100 });
    expect(nzb.kind === 'native' && nzb.input.settings).toMatchObject({ recentPriority: 'high', olderPriority: 'veryLow' });
  });

  it('stages implementations Arclight does not drive', () => {
    const r = mapDownloadClient('sonarr', 'TorrentBlackhole', common, { torrentFolder: '/bh' });
    expect(r.kind).toBe('staged');
    if (r.kind === 'staged') expect(r.staged).toMatchObject({ upstreamImplementation: 'TorrentBlackhole', directory: '/bh' });
  });
});

describe('notifications', () => {
  it('maps Discord settings and the trigger flags', () => {
    const r = mapNotification({ implementation: 'Discord', name: 'd', ongrab: 1, ondownload: 1, onseriesdelete: 1, onepisodefiledelete: 1, includehealthwarnings: 1 }, { webHookUrl: 'https://discord.com/api/webhooks/1/x', username: 'Bot' });
    expect(r.implementation).toBe('discord');
    expect(r.unsupported).toBeUndefined();
    expect(r.settings).toEqual({ webhookUrl: 'https://discord.com/api/webhooks/1/x', username: 'Bot' });
    expect(r.triggers).toMatchObject({ onGrab: true, onDownload: true, onSeriesDelete: true, onFileDelete: true, onUpgrade: false });
    expect(r.includeHealthWarnings).toBe(true);
  });

  it('flags settings that do not validate and unknown implementations', () => {
    expect(mapNotification({ implementation: 'Pushover', name: 'p' }, { apiKey: 'short', userKey: 'short' }).unsupported).toMatch(/do not validate/);
    expect(mapNotification({ implementation: 'Slack', name: 's' }, {}).unsupported).toMatch(/not supported/);
  });

  it('maps email encryption and MediaBrowser to Jellyfin by name', () => {
    const email = mapNotification({ implementation: 'Email', name: 'e' }, { server: 'smtp.x', port: 465, from: 'a@b.co', to: ['c@d.co'], useEncryption: 1 });
    expect(email.settings).toMatchObject({ host: 'smtp.x', port: 465, security: 'tls', to: ['c@d.co'] });
    expect(mapNotification({ implementation: 'MediaBrowser', name: 'My Jellyfin' }, { host: 'jf', apiKey: 'k' }).implementation).toBe('jellyfin');
  });
});

describe('indexers and import lists', () => {
  it('converts seed criteria minutes to milliseconds', () => {
    const s = mapIndexerSettings({ baseUrl: 'http://x', apiKey: 'k', categories: [5000, 'x'], seedCriteria: { seedRatio: 2, seedTime: 90, seasonPackSeedTime: 10 } });
    expect(s).toMatchObject({ baseUrl: 'http://x', apiPath: '/api', apiKey: 'k', categories: [5000], seedRatio: 2, seedTime: 5_400_000, seasonPackSeedTime: 600_000 });
    expect(prowlarrBaseUrl({ port: '9696', urlbase: 'prowlarr' })).toBe('http://localhost:9696/prowlarr');
  });

  it('maps TMDB/IMDb/Plex lists and refuses Trakt', () => {
    expect(mapImportListSettings('TMDbCollectionImport', { collectionId: '2344' })).toMatchObject({ implementation: 'tmdbCollection', settings: { collectionId: 2344 } });
    expect(mapImportListSettings('IMDbListImport', { listId: 'ls123' })).toMatchObject({ implementation: 'imdbList' });
    expect(mapImportListSettings('PlexImport', { accessToken: 'tok' })).toMatchObject({ implementation: 'plexWatchlist', settings: { plexToken: 'tok' } });
    expect(mapImportListSettings('TraktListImport', {}).unsupported).toMatch(/re-authorised/);
    expect(mapMonitorOption('radarr', 2)).toBe('none');
    expect(mapMonitorOption('sonarr', 'firstSeason')).toBe('firstSeason');
  });
});

describe('media management, media info, ratings', () => {
  it('maps config keys and remaps the recycle bin', () => {
    const v = mapMediaManagement({ recyclebin: '/data/recycle', copyusinghardlinks: 'False', downloadpropersandrepacks: 'DoNotPrefer', filedate: 'Cinemas', chmodfolder: '775' }, [{ from: '/data', to: '/srv' }]);
    expect(v).toEqual({ recycleBinPath: '/srv/recycle', useHardlinks: false, downloadPropersAndRepacks: 'doNotPrefer', fileDateMode: 'releaseDate', chmodFolder: '775' });
  });

  it('reads media info and both ratings shapes', () => {
    expect(mapMediaInfo({ videoFormat: 'x265', width: 3840, height: 2160, runTime: '01:02:03.5', audioLanguages: 'eng/jpn' })).toMatchObject({
      videoCodec: 'x265',
      resolution: '3840x2160',
      runtimeSeconds: 3723,
      audioLanguages: ['eng', 'jpn'],
    });
    expect(mapRatings({ votes: 5, value: 8 }, 'tvdb')).toEqual({ tvdb: { votes: 5, value: 8 } });
    expect(mapRatings({ imdb: { votes: 1, value: 7 }, tmdb: { votes: 0, value: 0 } }, 'tmdb')).toEqual({ imdb: { votes: 1, value: 7 } });
  });
});

describe('paths', () => {
  it('uses the longest matching prefix on whole segments', () => {
    const m = [
      { from: '/data', to: '/mnt/a' },
      { from: '/data/tv', to: '/media/tv' },
    ];
    expect(remapPath('/data/tv/Show', m)).toEqual({ path: '/media/tv/Show', mapped: true });
    expect(remapPath('/data/movies/X', m).path).toBe('/mnt/a/movies/X');
    expect(remapPath('/database/x', m)).toEqual({ path: '/database/x', mapped: false });
  });

  it('maps Windows paths case-insensitively onto POSIX and back', () => {
    expect(remapPath('d:\\TV\\Show\\Season 01', [{ from: 'D:\\tv', to: '/tv' }]).path).toBe('/tv/Show/Season 01');
    expect(remapPath('/tv/Show', [{ from: '/tv/', to: 'E:\\Media\\TV' }]).path).toBe('E:\\Media\\TV\\Show');
    expect(joinPath('E:\\TV\\Show', 'Season 01/ep.mkv')).toBe('E:\\TV\\Show\\Season 01\\ep.mkv');
  });
});

describe('config files', () => {
  it('parses Bazarr config.yaml lists, quoted scalars and nested maps', () => {
    const tree = parseSimpleYaml('---\ngeneral:\n  enabled_providers:\n  - opensubtitlescom\n  - addic7ed\n  flag: true\nopensubtitlescom:\n  username: u\n  password: \'p w\'\n  ids: [1, 2]\n');
    expect(tree).toEqual({ general: { enabled_providers: ['opensubtitlescom', 'addic7ed'], flag: true }, opensubtitlescom: { username: 'u', password: 'p w', ids: [1, 2] } });
  });

  it('parses config.ini and config.xml', () => {
    expect(parseIni("[general]\nenabled_providers = ['a', 'b']\n[a]\nusername = me\n")).toEqual({ general: { enabled_providers: ['a', 'b'] }, a: { username: 'me' } });
    expect(parseArrConfigXml('<Config><ApiKey>abc</ApiKey><Port>8989</Port><UrlBase /></Config>')).toEqual({ apikey: 'abc', port: '8989' });
  });
});

describe('source detection', () => {
  it('finds container mounts and Windows ProgramData installs that exist', () => {
    const present = new Set(['/config/sonarr.db', '/config/config.xml', '/import/bazarr/db/bazarr.db', 'C:\\ProgramData\\Radarr\\radarr.db']);
    const found = detectSources({ exists: (p) => present.has(p), env: { ProgramData: 'C:\\ProgramData' }, platform: 'win32', home: 'C:\\Users\\x' });
    expect(found).toEqual([
      { app: 'sonarr', dbPath: '/config/sonarr.db', configPath: '/config/config.xml', origin: 'container mount' },
      { app: 'bazarr', dbPath: '/import/bazarr/db/bazarr.db', configPath: null, origin: 'container mount' },
      { app: 'radarr', dbPath: 'C:\\ProgramData\\Radarr\\radarr.db', configPath: null, origin: 'Windows ProgramData' },
    ]);
  });
});
