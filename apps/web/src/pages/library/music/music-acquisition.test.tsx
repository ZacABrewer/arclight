import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QUALITIES } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { musicFacts } from '../../../api/music-acquisition.js';
import { audioSpecText, discographyText, logCueText } from './music-release-model.js';
import { FEATURES_ON, albumTypeProfiles, makeAlbum, makeAlbumDetails, makeArtist, makeArtistDetails, makeRelease, makeTrack, musicProfiles, musicRoots } from './music-fixtures.js';

// Wave 2 music acquisition in the web: interactive and automatic album searches, the Wanted
// album searches, music rows in Activity, the audio manual import, the profile domain
// selector and the audio custom-format conditions. Names are made up.

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const artist = makeArtist({ id: 1, name: 'Cobalt Drift' });
const album = makeAlbum({ id: 4, title: 'Glass Harbour', releaseDate: '2019-03-01', year: 2019 });
const second = makeAlbum({ id: 5, title: 'Low Tide', releaseDate: '2021-06-01', year: 2021 });

const job = (id: number, name: string) => ({ id, name, status: 'queued', trigger: 'manual', message: null, queuedAt: '2026-10-26T10:00:00.000Z', startedAt: null, endedAt: null, durationMs: null });
const flac = { quality: { ...QUALITIES.FLAC, mediaTypes: [...QUALITIES.FLAC.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };
const mp3 = { quality: { ...QUALITIES['MP3-320'], mediaTypes: [...QUALITIES['MP3-320'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };

/** A full parsed-music block (packages/shared ReleaseMusicInfo). */
function info(over: Record<string, unknown> = {}) {
  return {
    artist: 'Cobalt Drift',
    album: 'Glass Harbour',
    year: 2019,
    edition: null,
    isVariousArtists: false,
    packType: null,
    discographyYears: null,
    releaseTypeHint: null,
    media: 'Unknown',
    catalogNumber: null,
    discCount: null,
    codec: 'Unknown',
    bitrateKbps: null,
    bitDepth: null,
    sampleRateHz: null,
    hasLog: false,
    logScore: null,
    hasCue: false,
    ...over,
  } as Parameters<typeof musicFacts>[0]['music'] & object;
}

function decision(over: Record<string, unknown>) {
  return {
    guid: 'g1',
    title: 'Cobalt Drift - Glass Harbour (2019) [FLAC 24-96]',
    size: 900 * 1024 ** 2,
    publishDate: '2026-10-20T00:00:00.000Z',
    downloadUrl: 'http://indexer.invalid/1',
    categories: [3040],
    indexerId: 2,
    indexerName: 'Music Idx',
    indexerPriority: 25,
    protocol: 'torrent',
    seeders: 14,
    leechers: 1,
    age: 6,
    ageHours: 144,
    ageMinutes: 8640,
    rejections: [],
    approved: true,
    temporarilyRejected: false,
    downloadAllowed: true,
    source: 'interactiveSearch',
    mediaType: 'music',
    artistId: 1,
    albumIds: [4],
    quality: flac,
    languages: [],
    customFormats: [{ id: 9, name: 'Hi-Res' }],
    customFormatScore: 50,
    fullSeason: false,
    music: info({ media: 'WEB', codec: 'FLAC', bitDepth: 24, sampleRateHz: 96_000 }),
    ...over,
  };
}

function musicStub(extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/settings/features': FEATURES_ON,
    '/api/v1/qualityprofile': musicProfiles,
    '/api/v1/albumtypeprofile': albumTypeProfiles,
    '/api/v1/rootfolder': musicRoots,
    '/api/v1/tag': [],
    '/api/v1/artist': [artist],
    '/api/v1/album': [album, second],
    ...extra,
  });
}

describe('music release facts', () => {
  it('formats bit depth and sample rate, bitrates, log/cue and packs', () => {
    expect(audioSpecText(musicFacts({ music: info({ codec: 'FLAC', bitDepth: 24, sampleRateHz: 96_000 }) }))).toBe('24-bit / 96 kHz');
    expect(audioSpecText(musicFacts({ music: info({ codec: 'FLAC', sampleRateHz: 44_100 }) }))).toBe('44.1 kHz');
    expect(audioSpecText(musicFacts({ music: info({ codec: 'MP3', bitrateKbps: 320 }) }))).toBe('320 kbps');
    expect(audioSpecText(musicFacts({ music: info() }))).toBeNull();
    expect(audioSpecText(musicFacts({}))).toBeNull();
    expect(logCueText(musicFacts({ music: info({ hasLog: true, logScore: 100, hasCue: true }) }))).toBe('Log 100% · Cue');
    expect(logCueText(musicFacts({ music: info({ hasCue: true }) }))).toBe('Cue');
    expect(discographyText(musicFacts({ music: info({ packType: 'discography', discographyYears: { start: 1990, end: 2020 } }) }))).toBe('Discography 1990–2020');
    expect(discographyText(musicFacts({ music: info({ packType: 'discography' }) }))).toBe('Discography');
    expect(discographyText(musicFacts({ music: info({ packType: 'multiAlbum' }) }))).toBe('Multi-album pack');
    expect(discographyText(musicFacts({ music: info() }))).toBeNull();
  });
});

describe('album searches', () => {
  it('interactive search shows the music columns and grabs with the music target', async () => {
    const releases = [
      decision({}),
      decision({
        guid: 'g2',
        title: 'Cobalt Drift - Discography (2015-2021) [MP3 320]',
        approved: false,
        downloadAllowed: true,
        rejections: [{ reason: 'discographyPack', message: 'Discography packs are off', type: 'permanent' }],
        albumIds: [4, 5],
        albums: [
          { id: 4, title: 'Glass Harbour', year: 2019 },
          { id: 5, title: 'Low Tide', year: 2021 },
        ],
        quality: mp3,
        customFormats: [],
        customFormatScore: 0,
        music: info({ album: null, media: 'CD', hasLog: true, logScore: 100, hasCue: true, packType: 'discography', discographyYears: { start: 2015, end: 2021 }, codec: 'MP3', bitrateKbps: 320 }),
      }),
    ];
    const api = musicStub({
      '/api/v1/album/4': makeAlbumDetails(album, { artist }),
      '/api/v1/release': releases,
      'POST /api/v1/release': { title: releases[0]!.title, queueItemId: 3, downloadId: 'abc', downloadClientId: 1 },
    });
    renderAt('/library/music/album/4');
    fireEvent.click(await screen.findByRole('button', { name: 'Interactive search' }));
    const dialog = await screen.findByRole('dialog');
    const table = await within(dialog).findByRole('table', { name: 'Releases' });
    // The search asked for the album (and its artist), not a series.
    const search = api.calls.find((c) => c.method === 'GET' && c.path === '/api/v1/release');
    expect(search).toBeTruthy();
    for (const header of ['Audio', 'Media', 'Log / cue', 'Size', 'Peers', 'Indexer', 'Formats', 'Decision']) {
      expect(within(table).getByRole('columnheader', { name: new RegExp(header) })).toBeTruthy();
    }
    expect(within(table).getByText('24-bit / 96 kHz')).toBeTruthy();
    expect(within(table).getByText('320 kbps')).toBeTruthy();
    expect(within(table).getByText('WEB')).toBeTruthy();
    expect(within(table).getByTestId('logcue-badge').textContent).toBe('Log 100% · Cue');
    expect(within(table).getByTestId('discography-badge').textContent).toBe('Discography 2015–2021');
    expect(within(table).getAllByText('14 / 1')).toHaveLength(2);
    expect(within(table).getAllByText('Music Idx', { selector: 'td' })).toHaveLength(2);
    expect(within(table).getByText('Hi-Res')).toBeTruthy();
    expect(within(table).getByText('1 rejection')).toBeTruthy();
    expect(within(table).getByText('Covers 2 albums: Glass Harbour, Low Tide')).toBeTruthy();

    fireEvent.click(within(table).getByRole('button', { name: `Grab ${releases[0]!.title}` }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/release')?.body).toEqual({ guid: 'g1', indexerId: 2, artistId: 1, albumIds: [4] }),
    );
  });

  it('the release search query names the album and the artist', async () => {
    const api = musicStub({ '/api/v1/album/4': makeAlbumDetails(album, { artist }), '/api/v1/release': [] });
    renderAt('/library/music/album/4');
    fireEvent.click(await screen.findByRole('button', { name: 'Interactive search' }));
    expect(await screen.findByText('No releases found')).toBeTruthy();
    const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map(([u]) => String(u));
    expect(calls.find((u) => u.startsWith('/api/v1/release?'))).toMatch(/albumId=4/);
    expect(calls.find((u) => u.startsWith('/api/v1/release?'))).toMatch(/artistId=1/);
    expect(api.calls.some((c) => c.path === '/api/v1/release')).toBe(true);
  });

  it('Search on the album page starts an AlbumSearch; the artist page an ArtistSearch', async () => {
    const api = musicStub({
      '/api/v1/album/4': makeAlbumDetails(album, { artist }),
      '/api/v1/artist/1': makeArtistDetails(artist, [album]),
      'POST /api/v1/command': (init: RequestInit | undefined) => job(80, (JSON.parse(String(init?.body)) as { name: string }).name),
    });
    const router = renderAt('/library/music/album/4');
    await screen.findByRole('heading', { name: /Glass Harbour/, level: 1 });
    fireEvent.click(screen.getAllByRole('button', { name: 'Search' }).find((b) => b.getAttribute('data-variant') === 'primary')!);
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/command')?.body).toEqual({ name: 'AlbumSearch', albumIds: [4] }));
    expect(await screen.findByText('Album search started')).toBeTruthy();

    await router.navigate({ to: '/library/music/artist/$id', params: { id: '1' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Search monitored' }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/command').map((c) => c.body)).toContainEqual({ name: 'ArtistSearch', artistIds: [1] }),
    );
  });
});

describe('wanted albums', () => {
  const wanted = (a: typeof album) => ({ ...a, artistName: artist.name, mbArtistId: artist.mbArtistId, qualityProfileId: 11 });

  it('searches the selected albums, then every wanted album', async () => {
    const api = musicStub({
      '/api/v1/wanted/missing/episodes': { page: 1, pageSize: 50, totalRecords: 0, records: [] },
      '/api/v1/wanted/missing/albums': { page: 1, pageSize: 50, totalRecords: 2, records: [wanted(album), wanted(second)] },
      'POST /api/v1/command': job(81, 'AlbumSearch'),
    });
    renderAt('/wanted/missing');
    fireEvent.click(await screen.findByRole('button', { name: 'Albums' }));
    const table = await screen.findByRole('table', { name: 'Wanted albums' });
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Cobalt Drift - Low Tide' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Search selected' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/command')?.body).toEqual({ name: 'AlbumSearch', albumIds: [5] }));

    fireEvent.click(screen.getAllByRole('button', { name: 'Search all' })[0]!);
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/command').map((c) => c.body)).toContainEqual({ name: 'AlbumSearch', albumIds: [4, 5] }),
    );
  });
});

describe('music rows in Activity', () => {
  const queueItem = {
    id: 1,
    downloadId: 'abc123',
    downloadClientId: 1,
    downloadClientName: 'Client',
    title: 'Cobalt Drift - Glass Harbour (2019) [FLAC]',
    status: 'downloading',
    trackedStatus: 'ok',
    statusMessages: [],
    protocol: 'torrent',
    sizeBytes: 1000,
    sizeLeftBytes: 500,
    progress: 0.5,
    added: '2026-10-25T10:00:00.000Z',
    trackedState: 'downloading',
    mediaType: 'music',
    artistId: 1,
    albumIds: [4],
  };

  it('the queue labels music downloads "Artist – Album" with a music chip and an album link', async () => {
    musicStub({
      '/api/v1/queue': { page: 1, pageSize: 20, sortKey: 'added', sortDirection: 'desc', totalRecords: 1, records: [queueItem] },
      '/api/v1/queue/status': { totalCount: 1, errors: 0, warnings: 0, unknownCount: 0 },
      '/api/v1/downloadclient': [],
      '/api/v1/series': [],
      '/api/v1/movie': [],
    });
    renderAt('/activity/queue');
    const link = await screen.findByRole('link', { name: 'Cobalt Drift – Glass Harbour' });
    expect(link.getAttribute('href')).toBe('/library/music/album/4');
    const row = link.closest('tr')!;
    expect(row.querySelector('[data-kind="music"]')?.textContent).toBe('Music');
  });

  it('history rows carry the label too, with "+n" for packs', async () => {
    const record = (id: number, over: Record<string, unknown>) => ({
      id,
      eventType: 'grabbed',
      sourceTitle: `Release ${id}`,
      date: '2026-10-25T10:00:00.000Z',
      downloadId: null,
      mediaType: 'music',
      seriesId: null,
      episodeId: null,
      movieId: null,
      quality: flac,
      languages: [],
      data: {},
      ...over,
    });
    musicStub({
      '/api/v1/history': {
        page: 1,
        pageSize: 25,
        totalRecords: 2,
        records: [record(1, { artistId: 1, albumIds: [4] }), record(2, { artistId: 1, albumIds: [5, 4] })],
      },
    });
    renderAt('/activity/history');
    expect((await screen.findByRole('link', { name: 'Cobalt Drift – Glass Harbour' })).getAttribute('href')).toBe('/library/music/album/4');
    expect((await screen.findByRole('link', { name: 'Cobalt Drift – Low Tide (+1)' })).getAttribute('href')).toBe('/library/music/album/5');
  });

  it('pending and blocklist rows name the album', async () => {
    musicStub({
      '/api/v1/release/pending': [
        {
          id: 3,
          guid: 'p1',
          indexerId: 2,
          indexerName: 'Music Idx',
          title: 'Cobalt Drift - Low Tide [FLAC]',
          protocol: 'torrent',
          size: 1,
          publishDate: '2026-10-25T10:00:00.000Z',
          mediaType: 'music',
          artistId: 1,
          albumIds: [5],
          quality: flac,
          customFormatScore: 0,
          reason: 'delay',
          added: '2026-10-25T10:00:00.000Z',
          eligibleAt: '2099-01-01T00:00:00.000Z',
          remainingMinutes: 30,
        },
      ],
      '/api/v1/series': [],
      '/api/v1/movie': [],
      '/api/v1/blocklist': {
        page: 1,
        pageSize: 25,
        totalRecords: 1,
        records: [{ id: 9, sourceTitle: 'Cobalt Drift - Glass Harbour [MP3]', date: '2026-10-25T10:00:00.000Z', protocol: 'torrent', mediaType: 'music', artistId: 1, albumIds: [4] }],
      },
    });
    const router = renderAt('/activity/pending');
    expect((await screen.findByRole('link', { name: 'Cobalt Drift – Low Tide' })).getAttribute('href')).toBe('/library/music/album/5');
    await router.navigate({ to: '/activity/blocklist' });
    expect((await screen.findByRole('link', { name: 'Cobalt Drift – Glass Harbour' })).getAttribute('href')).toBe('/library/music/album/4');
  });
});

describe('manual import, audio mode', () => {
  const tracksOf = (releaseId: number, firstId: number, titles: string[]) =>
    titles.map((title, i) => makeTrack({ id: firstId + i, title, albumId: 4, albumReleaseId: releaseId, trackNumber: i + 1, absoluteNumber: i + 1 }));
  const releases = [
    makeRelease({ id: 7, title: 'Glass Harbour', albumId: 4, trackCount: 3, media: [{ position: 1, format: 'CD', trackCount: 3 }] }),
    makeRelease({ id: 8, title: 'Glass Harbour (Deluxe)', albumId: 4, trackCount: 4, media: [{ position: 1, format: 'CD', trackCount: 4 }] }),
  ];
  const standard = makeAlbumDetails({ ...album, selectedReleaseId: 7 }, { artist, releases, tracks: tracksOf(7, 1, ['Lighthouse', 'Breakwater', 'Salt']) });
  const deluxe = makeAlbumDetails({ ...album, selectedReleaseId: 8 }, { artist, releases, tracks: tracksOf(8, 11, ['Lighthouse', 'Breakwater', 'Salt', 'Undertow']) });
  const tags = { title: null, artist: 'Cobalt Drift', albumArtist: null, album: 'Glass Harbour', trackNo: null, discNo: null, durationMs: 200_000, codec: 'FLAC', bitrateKbps: null, sampleRateHz: 44_100, bitDepth: 16 };
  /** One AudioManualImportItem (packages/shared imports.ts). */
  const item = (n: number, over: Record<string, unknown> = {}) => ({
    path: `/downloads/Glass Harbour/0${n}.flac`,
    relativePath: `Glass Harbour/0${n}.flac`,
    name: `0${n}.flac`,
    sizeBytes: 30 * 1024 ** 2,
    quality: flac,
    mediaType: 'music',
    groupKey: 'g1',
    groupFolder: 'Glass Harbour',
    artistId: 1,
    albumId: 4,
    albumReleaseId: 7,
    trackIds: [n],
    mediumNumber: 1,
    trackNumber: n,
    trackTitle: 'x',
    confidence: 0.92,
    trackScore: 0.95,
    tags: { ...tags, trackNo: n, discNo: 1 },
    rejections: [],
    warnings: [],
    ...over,
  });
  const items = [
    item(1),
    item(2),
    item(9, { trackIds: undefined, mediumNumber: undefined, trackNumber: undefined, trackTitle: undefined, trackScore: undefined, rejections: [{ reason: 'trackMapping', message: 'Fits no track', type: 'permanent' }] }),
  ];

  it('scans for music, shows the track mapping, lets a track be chosen and imports', async () => {
    const api = musicStub({
      '/api/v1/album/4': standard,
      '/api/v1/queue': { page: 1, pageSize: 100, sortKey: 'added', sortDirection: 'desc', totalRecords: 0, records: [] },
      '/api/v1/manualimport/audio': items,
      'POST /api/v1/manualimport/audio': {
        imported: [{ path: items[0]!.path, audioFileId: 1, trackId: 1, destination: '/music/Cobalt Drift/Glass Harbour (2019)/01 - Lighthouse.flac' }],
        failed: [],
      },
    });
    renderAt('/activity/manual-import');
    fireEvent.click(await screen.findByRole('button', { name: 'Music' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder' }), { target: { value: '/downloads/Glass Harbour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Files: the album group with its confidence and the unmatched file.
    expect(await screen.findByText('3 audio files in 1 album, 2 mapped to tracks.')).toBeTruthy();
    expect(screen.getByText('1 unmatched')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Unmatched files' })).getByText(/Fits no track/)).toBeTruthy();
    const scan = (globalThis.fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map(([u]) => String(u)).find((u) => u.startsWith('/api/v1/manualimport/audio?'));
    expect(scan).toMatch(/folder=%2Fdownloads%2FGlass/);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const group = await screen.findByRole('region', { name: 'Album group Glass Harbour' });
    const table = within(group).getByRole('table', { name: 'Track mapping for Glass Harbour' });
    await waitFor(() => expect(within(table).getAllByRole('option', { name: '1-01 · Lighthouse' }).length).toBe(3));
    expect((within(group).getByRole('combobox', { name: 'Album for Glass Harbour' }) as HTMLSelectElement).value).toBe('4');
    expect((within(group).getByRole('combobox', { name: 'Edition for Glass Harbour' }) as HTMLSelectElement).value).toBe('7');
    expect(within(group).getByRole('button', { name: 'Artist for Glass Harbour' }).textContent).toContain('Cobalt Drift');
    expect(within(table).getByText('Unmatched')).toBeTruthy();
    expect(within(table).getAllByText('95%')).toHaveLength(2);

    // Map the unmatched file to track 3; mapping it to track 1 instead would collide.
    const pick = within(table).getByRole('combobox', { name: 'Track for Glass Harbour/09.flac' });
    fireEvent.change(pick, { target: { value: '3' } });
    expect(within(table).queryByText('Unmatched')).toBeNull();
    fireEvent.change(pick, { target: { value: '1' } });
    expect(within(group).getByText('Two files map to one track')).toBeTruthy();
    fireEvent.change(pick, { target: { value: '3' } });

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import 3 files' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/manualimport/audio')?.body).toEqual({
        importMode: 'auto',
        items: [
          { path: items[0]!.path, artistId: 1, albumId: 4, trackIds: [1] },
          { path: items[1]!.path, artistId: 1, albumId: 4, trackIds: [2] },
          { path: items[2]!.path, artistId: 1, albumId: 4, trackIds: [3] },
        ],
      }),
    );
    expect(await screen.findByText('Imported 1, failed 0.')).toBeTruthy();
  });

  it('switching the edition updates the album, then re-maps the files by position', async () => {
    let current = standard;
    const api = musicStub({
      '/api/v1/album/4': () => current,
      'PUT /api/v1/album/4': () => {
        current = deluxe;
        return { ...album, selectedReleaseId: 8 };
      },
      '/api/v1/manualimport/audio': items,
      'POST /api/v1/manualimport/audio': { imported: [], failed: [] },
    });
    renderAt('/activity/manual-import?folder=%2Fdownloads%2FGlass%20Harbour&mediaType=music');
    await screen.findByText('3 audio files in 1 album, 2 mapped to tracks.');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const group = await screen.findByRole('region', { name: 'Album group Glass Harbour' });
    const edition = within(group).getByRole('combobox', { name: 'Edition for Glass Harbour' }) as HTMLSelectElement;
    await waitFor(() => expect(edition.disabled).toBe(false));
    fireEvent.change(edition, { target: { value: '8' } });
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/album/4')?.body).toEqual({ selectedReleaseId: 8 }));
    // The deluxe tracks arrive and the two placed files map to them by disc/track.
    const first = within(group).getByRole('combobox', { name: 'Track for Glass Harbour/01.flac' }) as HTMLSelectElement;
    await waitFor(() => expect(first.value).toBe('11'));
    expect([...first.options].map((o) => o.textContent)).toContain('1-04 · Undertow');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 files' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/manualimport/audio')?.body).toEqual({
        importMode: 'auto',
        items: [
          { path: items[0]!.path, artistId: 1, albumId: 4, trackIds: [11] },
          { path: items[1]!.path, artistId: 1, albumId: 4, trackIds: [12] },
        ],
      }),
    );
  });
});

describe('quality profile domains', () => {
  const videoProfile = {
    id: 1,
    name: 'HD',
    upgradeAllowed: true,
    cutoff: 3,
    items: [{ kind: 'quality', qualityId: 3, allowed: true }],
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
    mediaDomain: 'video',
  };
  const formats = [
    { id: 7, name: 'Dolby Vision', includeWhenRenaming: false, specifications: [{ implementation: 'source', name: 'WEB', negate: false, required: false, fields: { source: 'web' } }] },
    { id: 8, name: 'Lossless only', includeWhenRenaming: false, specifications: [{ implementation: 'audioCodec', name: 'FLAC', negate: false, required: false, fields: { codec: 'FLAC' } }] },
    { id: 9, name: 'Scene group', includeWhenRenaming: false, specifications: [{ implementation: 'releaseGroup', name: 'Group', negate: false, required: false, fields: { pattern: 'GRP' } }] },
  ];
  const profilesStub = () =>
    stubApi({
      '/api/v1/settings/features': FEATURES_ON,
      '/api/v1/qualityprofile': [videoProfile, ...musicProfiles],
      '/api/v1/qualityprofile/schema': { ...videoProfile, id: undefined, name: '', items: [{ kind: 'quality', qualityId: 3, allowed: false }] },
      '/api/v1/customformat': formats,
      '/api/v1/delayprofile': [],
      '/api/v1/releaseprofile': [],
      '/api/v1/tag': [],
      '/api/v1/rootfolder': [],
      '/api/v1/albumtypeprofile': albumTypeProfiles,
      '/api/v1/profilemigration/profiles': [],
      'POST /api/v1/qualityprofile': (init: RequestInit | undefined) => ({ ...(JSON.parse(String(init?.body)) as object), id: 30 }),
    });

  it('groups profiles by domain', async () => {
    profilesStub();
    renderAt('/settings/profiles');
    const video = await screen.findByTestId('profiles-video');
    const music = screen.getByTestId('profiles-music');
    expect(within(video).getByText('HD')).toBeTruthy();
    expect(within(video).queryByText('Lossless')).toBeNull();
    expect(within(music).getByText('Lossless')).toBeTruthy();
    expect(within(music).getByText('Any MP3')).toBeTruthy();
  });

  it('a new profile lists only its domain qualities and formats', async () => {
    const api = profilesStub();
    renderAt('/settings/profiles');
    fireEvent.click(await screen.findByRole('button', { name: /Add Video profile/ }));
    const dialog = await screen.findByRole('dialog');
    const list = within(dialog).getByRole('list', { name: 'Qualities' });
    expect(within(list).queryByText('FLAC')).toBeNull();
    // Video formats and domain-neutral ones; not the audio one.
    expect(within(dialog).getByText('Dolby Vision')).toBeTruthy();
    expect(within(dialog).getByText('Scene group')).toBeTruthy();
    expect(within(dialog).queryByText('Lossless only')).toBeNull();

    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Media' })).getByRole('button', { name: 'Music' }));
    const audio = within(dialog).getByRole('list', { name: 'Qualities' });
    expect(within(audio).getByText('FLAC')).toBeTruthy();
    expect(within(audio).getByText('MP3-320')).toBeTruthy();
    expect(within(audio).queryByText('WEBDL-1080p')).toBeNull();
    expect(within(dialog).queryByText('Dolby Vision')).toBeNull();
    expect(within(dialog).getByText('Lossless only')).toBeTruthy();
    expect(within(dialog).getByText('Scene group')).toBeTruthy();
    // Audio profiles have no language list; the audiobook domain is hidden while its flag is off.
    expect(within(dialog).queryByRole('group', { name: 'Languages' })).toBeNull();
    expect(within(within(dialog).getByRole('group', { name: 'Media' })).queryByRole('button', { name: 'Audiobooks' })).toBeNull();

    fireEvent.change(within(dialog).getAllByRole('textbox')[0]!, { target: { value: 'Hi-Res' } });
    fireEvent.click(within(audio).getByRole('checkbox', { name: 'Allow FLAC' }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Upgrade until' }), { target: { value: '131' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/qualityprofile')).toBeTruthy());
    const body = api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/qualityprofile')!.body as { mediaDomain: string; cutoff: number; items: Array<{ qualityId: number }> };
    expect(body.mediaDomain).toBe('music');
    expect(body.cutoff).toBe(131);
    expect(body.items.every((i) => i.qualityId >= 100)).toBe(true);
  });

  it('series and movie pickers ask for video profiles only', async () => {
    const api = stubApi({ '/api/v1/settings/features': FEATURES_ON, '/api/v1/qualityprofile': [videoProfile], '/api/v1/rootfolder': [], '/api/v1/tag': [] });
    renderAt('/library/add');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/qualityprofile')).toBe(true));
    const urls = (globalThis.fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/v1/qualityprofile'));
    expect(urls.every((u) => u.includes('mediaDomain=video'))).toBe(true);
  });
});

describe('audio custom-format conditions', () => {
  const cfStub = (features = FEATURES_ON) =>
    stubApi({
      '/api/v1/settings/features': features,
      '/api/v1/customformat': [
        { id: 8, name: 'Lossless only', includeWhenRenaming: false, specifications: [{ implementation: 'audioCodec', name: 'FLAC', negate: false, required: false, fields: { codec: 'FLAC' } }] },
        { id: 9, name: 'Scene group', includeWhenRenaming: false, specifications: [{ implementation: 'releaseGroup', name: 'Group', negate: false, required: false, fields: { pattern: 'GRP' } }] },
      ],
      '/api/v1/customformat/schema': [],
      '/api/v1/qualityprofile': [],
      'POST /api/v1/customformat': (init: RequestInit | undefined) => ({ ...(JSON.parse(String(init?.body)) as object), id: 40 }),
    });

  it('marks each format with its domain', async () => {
    cfStub();
    renderAt('/settings/customformats');
    await screen.findByText('Lossless only');
    const chips = screen.getAllByTestId('format-domain').map((c) => [c.getAttribute('data-domain'), c.textContent]);
    expect(chips).toEqual([
      ['music', 'Music'],
      ['any', 'Any media'],
    ]);
  });

  it('edits bitrate, sample rate and rip-log conditions and validates their bands', async () => {
    const api = cfStub();
    renderAt('/settings/customformats');
    await screen.findByText('Lossless only');
    await waitFor(() => expect((screen.getAllByRole('button', { name: 'Add custom format' })[0] as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getAllByRole('button', { name: 'Add custom format' })[0]!);
    const dialog = await screen.findByRole('dialog');
    const add = within(dialog).getByRole('combobox', { name: 'Add condition' }) as HTMLSelectElement;
    const kinds = [...add.options].map((o) => o.textContent);
    expect(kinds).toEqual(expect.arrayContaining(['Audio codec', 'Audio bitrate', 'Bit depth', 'Sample rate', 'Audio source', 'Rip log']));
    // Audiobook conditions wait for the audiobooks flag.
    expect(kinds).not.toContain('Narrator');

    fireEvent.change(within(dialog).getAllByRole('textbox')[0]!, { target: { value: 'Hi-Res rip' } });
    fireEvent.change(add, { target: { value: 'audioBitrate' } });
    fireEvent.change(add, { target: { value: 'sampleRate' } });
    fireEvent.change(add, { target: { value: 'ripLog' } });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Minimum bitrate' }), { target: { value: '400' } });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Minimum sample rate' }), { target: { value: '88.2' } });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Require a rip log' }));
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Minimum log score' }), { target: { value: '100' } });
    expect(within(dialog).getByTestId('format-domain').textContent).toBe('Music');

    // 400 kbps above the 320 maximum is refused.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Must be at least the minimum.')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/customformat')).toBe(false);

    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Maximum bitrate' }), { target: { value: '9000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/customformat')?.body).toEqual({
        name: 'Hi-Res rip',
        includeWhenRenaming: false,
        specifications: [
          { implementation: 'audioBitrate', name: 'Audio bitrate', negate: false, required: false, fields: { minKbps: 400, maxKbps: 9000 } },
          { implementation: 'sampleRate', name: 'Sample rate', negate: false, required: false, fields: { minKhz: 88.2, maxKhz: 192 } },
          { implementation: 'ripLog', name: 'Rip log', negate: false, required: false, fields: { requireLog: true, minScore: 100, requireCue: false } },
        ],
      }),
    );
  });

  it('shows the audiobook conditions only with audiobooks on', async () => {
    cfStub({ music: true, audiobooks: true });
    renderAt('/settings/customformats');
    await screen.findByText('Lossless only');
    await waitFor(() => expect((screen.getAllByRole('button', { name: 'Add custom format' })[0] as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getAllByRole('button', { name: 'Add custom format' })[0]!);
    const dialog = await screen.findByRole('dialog');
    const add = within(dialog).getByRole('combobox', { name: 'Add condition' }) as HTMLSelectElement;
    await waitFor(() => expect([...add.options].map((o) => o.textContent)).toEqual(expect.arrayContaining(['Narrator', 'File layout', 'Format type'])));
    fireEvent.change(add, { target: { value: 'bitDepth' } });
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Bit depth' })).getByRole('button', { name: '16-bit' }));
    fireEvent.change(add, { target: { value: 'audioSource' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Source' }), { target: { value: 'vinyl' } });
    expect((within(dialog).getByRole('combobox', { name: 'Source' }) as HTMLSelectElement).value).toBe('vinyl');
  });
});
