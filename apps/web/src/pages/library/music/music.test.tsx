import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { CalendarItem } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { navFor, sectionTabs } from '../../../nav.js';
import { isLoadingAlbums, withAlbumsMonitored } from '../../../hooks/music.js';
import { artistResultMeta } from './add-artist.js';
import {
  DEFAULT_ARTIST_FILTERS,
  albumState,
  artistFolder,
  filterArtists,
  formatDuration,
  groupAlbums,
  groupTracks,
  initialOf,
  releaseLabel,
  sortArtists,
  trackProgress,
} from './music-model.js';
import {
  FEATURES_OFF,
  FEATURES_ON,
  albumTypeProfiles,
  makeAlbum,
  makeAlbumDetails,
  makeArtist,
  makeArtistDetails,
  makeAudioFile,
  makeRelease,
  makeTrack,
  musicProfiles,
  musicRoots,
} from './music-fixtures.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const radiohead = makeArtist({
  id: 1,
  name: 'Radiohead',
  genres: ['alternative rock', 'art rock'],
  overview: 'English rock band from Abingdon.',
  links: [{ name: 'official homepage', url: 'https://example.org/radiohead' }],
  images: [{ coverType: 'poster', url: '/img/radiohead.jpg' }],
});
const portishead = makeArtist({ id: 2, name: 'Portishead', monitored: false, statistics: { trackCount: 10, trackFileCount: 10, totalTrackCount: 10, sizeOnDisk: 1, percentOfTracks: 100, albumCount: 1, monitoredAlbumCount: 0, completeAlbumCount: 1 } });

const albums = [
  makeAlbum({ id: 3, title: 'OK Computer', releaseDate: '1997-05-21', year: 1997 }),
  makeAlbum({ id: 4, title: 'In Rainbows', releaseDate: '2007-10-10', year: 2007 }),
  makeAlbum({ id: 5, title: 'My Iron Lung', primaryType: 'EP', releaseDate: '1994-09-26', year: 1994 }),
  makeAlbum({ id: 6, title: 'Creep', primaryType: 'Single', releaseDate: '1992-09-21', year: 1992, monitored: false }),
  makeAlbum({ id: 7, title: 'Airbag / How Am I Driving?', primaryType: 'EP', releaseDate: '1998-04-21', year: 1998, monitored: false }),
];

/** Routes every music page needs; `extra` adds or overrides. */
function musicApi(extra: Record<string, unknown> = {}, features = FEATURES_ON) {
  return stubApi({
    '/api/v1/settings/features': features,
    '/api/v1/qualityprofile': musicProfiles,
    '/api/v1/albumtypeprofile': albumTypeProfiles,
    '/api/v1/rootfolder': musicRoots,
    '/api/v1/tag': [],
    ...extra,
  });
}

describe('music model', () => {
  it('groups albums by primary type in a fixed order, newest first', () => {
    const groups = groupAlbums(albums);
    expect(groups.map((g) => g.type)).toEqual(['Album', 'EP', 'Single']);
    expect(groups[0]!.albums.map((a) => a.title)).toEqual(['In Rainbows', 'OK Computer']);
  });

  it('formats durations, initials, progress and destination folders', () => {
    expect(formatDuration(221_000)).toBe('3:41');
    expect(formatDuration(3_727_000)).toBe('1:02:07');
    expect(formatDuration(null)).toBe('—');
    expect(initialOf('The National')).toBe('N');
    expect(initialOf('!!!')).toBe('#');
    expect(trackProgress({ trackCount: 10, trackFileCount: 4, totalTrackCount: 12 })).toEqual({ have: 4, total: 12, percent: (4 / 12) * 100 });
    expect(artistFolder('/data/music/', 'AC/DC')).toBe('/data/music/ACDC');
    expect(artistFolder('D:\\Music', 'Björk')).toBe('D:\\Music\\Björk');
  });

  it('filters by name and aliases, monitored and missing; sorts by size', () => {
    const list = [radiohead, portishead, makeArtist({ id: 3, name: 'Sigur Rós', aliases: ['Sigur Ros'] })];
    expect(filterArtists(list, { ...DEFAULT_ARTIST_FILTERS, search: 'sigur ros' }).map((a) => a.id)).toEqual([3]);
    expect(filterArtists(list, { ...DEFAULT_ARTIST_FILTERS, monitored: 'unmonitored' }).map((a) => a.id)).toEqual([2]);
    expect(filterArtists(list, { ...DEFAULT_ARTIST_FILTERS, missing: true }).map((a) => a.id)).toEqual([1, 3]);
    expect(sortArtists(list, { key: 'size', direction: 'asc' })[0]!.id).toBe(2);
  });

  it('labels editions and groups tracks per disc', () => {
    const cd = makeRelease({ id: 2, title: 'OK Computer', formats: ['CD'], country: 'GB', trackCount: 3, date: '1997-06-16', mediumCount: 2, media: [{ position: 1, format: 'CD', trackCount: 2 }, { position: 2, format: 'CD', trackCount: 1 }] });
    expect(releaseLabel(cd)).toBe('OK Computer · CD · GB · 3 tracks · 1997-06-16');
    const discs = groupTracks([makeTrack({ id: 3, title: 'C', mediumNumber: 2, trackNumber: 1 }), makeTrack({ id: 2, title: 'B', trackNumber: 2 }), makeTrack({ id: 1, title: 'A', trackNumber: 1 })], cd);
    expect(discs.map((d) => [d.medium, d.format, d.tracks.map((t) => t.title)])).toEqual([
      [1, 'CD', ['A', 'B']],
      [2, 'CD', ['C']],
    ]);
  });

  it('derives the album state and the "loading albums" state', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    expect(albumState(makeAlbum({ id: 1, title: 'x', releaseDate: '2027-01-01' }), now)).toBe('unaired');
    expect(albumState(makeAlbum({ id: 1, title: 'x', statistics: { trackCount: 2, trackFileCount: 2, totalTrackCount: 2, sizeOnDisk: 1, percentOfTracks: 100 } }), now)).toBe('downloaded');
    expect(albumState(makeAlbum({ id: 1, title: 'x' }), now)).toBe('wanted');
    expect(isLoadingAlbums({ albums: [], lastRefreshed: null })).toBe(true);
    expect(isLoadingAlbums({ albums: [], lastRefreshed: '2026-01-01' })).toBe(false);
    expect(withAlbumsMonitored({ albums }, [3, 4], false).albums.map((a) => a.monitored)).toEqual([false, false, true, false, false]);
    expect(artistResultMeta({ artistType: 'Group', country: 'GB', beginDate: '1985', endDate: null, ended: false })).toBe('Group · GB · 1985 –');
  });
});

describe('feature flag', () => {
  it('hides Library → Music in the nav tree while music is off', () => {
    expect(sectionTabs('/library/tv', true, navFor(FEATURES_OFF)).map((t) => t.to)).not.toContain('/library/music');
    expect(sectionTabs('/library/tv', true, navFor(FEATURES_ON)).map((t) => t.to)).toContain('/library/music');
    // The label stays a live getter (follows the UI language).
    const library = navFor(FEATURES_ON).find((s) => s.to === '/library/tv');
    expect(Object.getOwnPropertyDescriptor(library!, 'label')?.get).toBeTypeOf('function');
  });

  it('answers 404 on the music routes and shows no Music tab while the flag is off', async () => {
    musicApi({ '/api/v1/artist': [radiohead] }, FEATURES_OFF);
    renderAt('/library/music');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Section' });
    expect(within(tabs).queryByRole('link', { name: 'Music' })).toBeNull();
    expect(within(tabs).getByRole('link', { name: 'TV' })).toBeTruthy();
  });

  it('adds the Music section tab once the flag is on', async () => {
    musicApi({ '/api/v1/artist': [radiohead, portishead] });
    renderAt('/library/music');
    const grid = await screen.findByTestId('artist-grid');
    const tabs = screen.getByRole('navigation', { name: 'Section' });
    expect(within(tabs).getByRole('link', { name: 'Music' }).getAttribute('aria-current')).toBe('page');
    expect(within(grid).getByRole('link', { name: 'Radiohead' }).getAttribute('href')).toBe('/library/music/artist/1');
    // Square artwork: the image when there is one, the initial otherwise.
    expect(within(grid).getByRole('img', { name: 'Radiohead' }).getAttribute('src')).toBe('/img/radiohead.jpg');
    expect(within(grid).getByRole('img', { name: 'Portishead' }).textContent).toBe('P');
    expect(within(grid).getByText('10/20')).toBeTruthy();
    expect(document.querySelector('.mk-count')?.textContent).toMatch(/^2 artists/);
  });

  it('switches the artist index to the table view with album and track columns', async () => {
    musicApi({ '/api/v1/artist': [radiohead, portishead] });
    renderAt('/library/music');
    await screen.findByTestId('artist-grid');
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const table = await screen.findByRole('table', { name: 'Music' });
    expect(within(table).getByRole('columnheader', { name: 'Albums' })).toBeTruthy();
    expect(within(table).getByRole('progressbar', { name: 'Radiohead progress' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter artists'), { target: { value: 'porti' } });
    await waitFor(() => expect(within(table).queryByText('Radiohead')).toBeNull());
  });
});

describe('add artist', () => {
  it('searches MusicBrainz, shows disambiguation, and adds with music profiles and album types', async () => {
    const added = makeArtist({ id: 9, name: 'Radiohead', lastRefreshed: null });
    const api = musicApi({
      '/api/v1/series': [],
      '/api/v1/movie': [],
      '/api/v1/artist/lookup': [
        { mbArtistId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', name: 'Radiohead', sortName: 'Radiohead', disambiguation: 'UK rock band', artistType: 'Group', country: 'GB', beginDate: '1985', genres: ['rock'], images: [], score: 100 },
        { mbArtistId: '8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11', name: 'Portishead', sortName: 'Portishead', genres: [], images: [], score: 60, artistId: 2 },
      ],
      'POST /api/v1/artist': added,
      '/api/v1/artist/9': { ...added, albums: [] },
    });
    renderAt('/library/add?type=music');
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search MusicBrainz' }), { target: { value: 'radiohead' } });
    const list = await screen.findByRole('list', { name: 'Search results' });
    expect(within(list).getByText('(UK rock band)')).toBeTruthy();
    expect(within(list).getByText('Group · GB · 1985 –')).toBeTruthy();
    expect(within(list).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/library/music/artist/2');
    expect(api.calls.find((c) => c.path === '/api/v1/artist/lookup')).toBeTruthy();

    fireEvent.click(within(list).getByRole('button', { name: 'Add Radiohead' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Radiohead' });
    await waitFor(() => expect((within(dialog).getByLabelText('Root folder') as HTMLSelectElement).value).toBe('/data/music'));
    // Only music roots are offered.
    expect(within(dialog).queryByRole('option', { name: '/data/tv' })).toBeNull();
    expect(within(dialog).getByRole('option', { name: 'Any MP3' })).toBeTruthy();
    await waitFor(() => expect((within(dialog).getByLabelText('Album types') as HTMLSelectElement).value).toBe('1'));
    fireEvent.change(within(dialog).getByLabelText('Monitor'), { target: { value: 'future' } });
    fireEvent.change(within(dialog).getByLabelText('Monitor new albums'), { target: { value: 'none' } });
    expect(within(dialog).getByTestId('path-preview').textContent).toBe('/data/music/Radiohead');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add artist' }));

    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/artist')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/artist')!.body).toEqual({
      mbArtistId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
      rootFolderPath: '/data/music',
      qualityProfileId: 11,
      albumTypeProfileId: 1,
      monitored: true,
      monitorOption: 'future',
      monitorNewAlbums: 'none',
      tags: [],
      searchOnAdd: false,
    });
    // The profile picker asked for music profiles.
    expect(api.calls.some((c) => c.path === '/api/v1/qualityprofile')).toBe(true);
    // Lands on the new artist while its albums load in the background.
    expect(await screen.findByTestId('loading-albums')).toBeTruthy();
  });

  it('offers no Music tab on Add New while the flag is off', async () => {
    musicApi({ '/api/v1/series': [], '/api/v1/movie': [] }, FEATURES_OFF);
    renderAt('/library/add?type=music');
    const kinds = await screen.findByRole('group', { name: 'Result type' }).catch(() => screen.findByLabelText('Result type'));
    expect(within(kinds).queryByRole('button', { name: 'Music' })).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Search TMDB' })).toBeTruthy();
  });
});

describe('artist details', () => {
  it('groups albums by type with covers, years, track progress and monitor toggles', async () => {
    const api = musicApi({
      '/api/v1/artist/1': makeArtistDetails(radiohead, albums),
      'PUT /api/v1/album/4': makeAlbum({ id: 4, title: 'In Rainbows', monitored: false }),
      'PUT /api/v1/album/monitor': null,
      'POST /api/v1/command': { id: 70, name: 'RefreshArtist', status: 'queued', trigger: 'manual', message: null, queuedAt: '2026-10-26T10:00:00.000Z', startedAt: null, endedAt: null, durationMs: null },
    });
    renderAt('/library/music/artist/1');
    expect(await screen.findByRole('heading', { name: /Radiohead/, level: 1 })).toBeTruthy();
    expect(screen.getByText('English rock band from Abingdon.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Website' }).getAttribute('href')).toBe('https://example.org/radiohead');
    expect(screen.getByRole('link', { name: 'MusicBrainz' })).toBeTruthy();
    expect(screen.getByText('Lossless')).toBeTruthy();
    expect(screen.getByText('Studio albums')).toBeTruthy();

    const sections = ['Album', 'EP', 'Single'].map((type) => screen.getByTestId(`album-group-${type}`));
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['Albums', 'EPs', 'Singles']);
    const studio = within(sections[0]!).getAllByRole('article').map((a) => a.getAttribute('aria-label'));
    expect(studio).toEqual(['In Rainbows', 'OK Computer']);
    expect(within(sections[0]!).getByRole('link', { name: /In Rainbows/ }).getAttribute('href')).toBe('/library/music/album/4');
    expect(within(sections[0]!).getByText('2007')).toBeTruthy();

    fireEvent.click(within(sections[0]!).getByRole('switch', { name: 'Unmonitor In Rainbows' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/album/4')?.body).toEqual({ monitored: false }));

    // The group switch monitors every album of the type in one request (newest first).
    fireEvent.click(within(sections[1]!).getByRole('switch', { name: 'Monitor EPs' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/album/monitor')?.body).toEqual({ albumIds: [7, 5], monitored: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/command')?.body).toEqual({ name: 'RefreshArtist', artistIds: [1] }));
    // "Search monitored" starts an ArtistSearch.
    fireEvent.click(screen.getByRole('button', { name: 'Search monitored' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/command').map((c) => c.body)).toContainEqual({ name: 'ArtistSearch', artistIds: [1] }));
  });

  it('says albums are loading for an artist that was just added', async () => {
    musicApi({ '/api/v1/artist/1': makeArtistDetails({ ...radiohead, lastRefreshed: null }, []) });
    renderAt('/library/music/artist/1');
    expect(await screen.findByTestId('loading-albums')).toBeTruthy();
  });
});

describe('album details', () => {
  const digital = makeRelease({ id: 1, title: 'OK Computer', formats: ['Digital Media'], country: 'XW', trackCount: 2 });
  const cd = makeRelease({ id: 2, title: 'OK Computer', formats: ['CD'], country: 'GB', trackCount: 3, date: '1997-06-16', mediumCount: 2, media: [{ position: 1, format: 'CD', trackCount: 2 }, { position: 2, format: 'CD', trackCount: 1 }] });
  const file = makeAudioFile({ id: 50, trackNumber: 1 });
  const details = makeAlbumDetails(makeAlbum({ id: 3, title: 'OK Computer', selectedReleaseId: 1, year: 1997, releaseDate: '1997-05-21' }), {
    artist: radiohead,
    releases: [digital, cd],
    tracks: [makeTrack({ id: 1, title: 'Airbag', hasFile: true, audioFileId: 50, durationMs: 284_000 }), makeTrack({ id: 2, title: 'Paranoid Android', durationMs: 383_000 })],
    files: [file],
  });

  it('lists tracks with duration, file and quality, and switches the edition', async () => {
    const api = musicApi({ '/api/v1/album/3': details, 'PUT /api/v1/album/3': { ...details, selectedReleaseId: 2 } });
    renderAt('/library/music/album/3');
    expect(await screen.findByRole('heading', { name: /OK Computer/, level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Radiohead' }).getAttribute('href')).toBe('/library/music/artist/1');
    const table = screen.getByRole('table', { name: 'Disc 1' });
    const airbag = within(table).getByRole('row', { name: /Airbag/ });
    expect(within(airbag).getByText('4:44')).toBeTruthy();
    expect(within(airbag).getByText('Downloaded')).toBeTruthy();
    expect(within(airbag).getByText('FLAC')).toBeTruthy();
    expect(within(within(table).getByRole('row', { name: /Paranoid Android/ })).getByText('Missing')).toBeTruthy();

    const edition = screen.getByLabelText('Edition') as HTMLSelectElement;
    expect(edition.value).toBe('1');
    expect(within(edition).getByRole('option', { name: 'OK Computer · CD · GB · 3 tracks · 1997-06-16' })).toBeTruthy();
    fireEvent.change(edition, { target: { value: '2' } });
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/album/3')?.body).toEqual({ selectedReleaseId: 2 }));

    fireEvent.click(screen.getByRole('tab', { name: /Files/ }));
    expect(await screen.findByText('Album/050.flac')).toBeTruthy();
    expect(screen.getByText('44.1 kHz')).toBeTruthy();
  });

  it('groups a multi-disc edition by disc', async () => {
    const multi = {
      ...details,
      selectedReleaseId: 2,
      tracks: [makeTrack({ id: 1, title: 'Airbag', albumReleaseId: 2 }), makeTrack({ id: 2, title: 'Lucky', albumReleaseId: 2, trackNumber: 2 }), makeTrack({ id: 3, title: 'Polyethylene', albumReleaseId: 2, mediumNumber: 2, trackNumber: 1 })],
    };
    musicApi({ '/api/v1/album/3': multi });
    renderAt('/library/music/album/3');
    expect(await screen.findByRole('region', { name: 'Disc 1 · CD' })).toBeTruthy();
    const disc2 = screen.getByRole('region', { name: 'Disc 2 · CD' });
    expect(within(disc2).getByText('Polyethylene')).toBeTruthy();
    expect(within(disc2).queryByText('Airbag')).toBeNull();
  });
});

describe('wanted albums', () => {
  it('adds an Albums kind to missing with a searchable list', async () => {
    const wanted = { ...makeAlbum({ id: 4, title: 'In Rainbows', releaseDate: '2007-10-10' }), artistName: 'Radiohead', mbArtistId: radiohead.mbArtistId, qualityProfileId: 11 };
    const api = musicApi({
      '/api/v1/wanted/missing/episodes': { page: 1, pageSize: 50, totalRecords: 0, records: [] },
      '/api/v1/wanted/missing/albums': { page: 1, pageSize: 50, totalRecords: 1, records: [wanted] },
      'POST /api/v1/command': { id: 71, name: 'AlbumSearch', status: 'queued', trigger: 'manual', message: null, queuedAt: '2026-10-26T10:00:00.000Z', startedAt: null, endedAt: null, durationMs: null },
    });
    renderAt('/wanted/missing');
    fireEvent.click(await screen.findByRole('button', { name: 'Albums' }));
    const table = await screen.findByRole('table', { name: 'Wanted albums' });
    expect(within(table).getByRole('link', { name: 'Radiohead' }).getAttribute('href')).toBe('/library/music/artist/1');
    expect(within(table).getByRole('link', { name: 'In Rainbows' }).getAttribute('href')).toBe('/library/music/album/4');
    expect(within(table).getByText('5/10')).toBeTruthy();
    expect(within(table).getByText('Lossless')).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: 'Search Radiohead - In Rainbows' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/command')?.body).toEqual({ name: 'AlbumSearch', albumIds: [4] }));
    expect(api.calls.some((c) => c.path === '/api/v1/wanted/missing/albums')).toBe(true);
    // The header keeps the kind switch only: no route tabs.
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('has no Albums kind while music is off', async () => {
    musicApi({ '/api/v1/wanted/missing/episodes': { page: 1, pageSize: 50, totalRecords: 0, records: [] } }, FEATURES_OFF);
    renderAt('/wanted/missing');
    expect(await screen.findByRole('button', { name: 'Movies' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Albums' })).toBeNull();
  });
});

describe('calendar albums', () => {
  it('renders album release dates with a music chip in the month grid, popover and agenda', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0));
    const item: CalendarItem = {
      type: 'album',
      date: '2026-10-20',
      artistId: 1,
      artistName: 'Radiohead',
      album: makeAlbum({ id: 8, title: 'New Album', releaseDate: '2026-10-20', year: 2026 }),
      artist: { id: 1, mbArtistId: radiohead.mbArtistId, name: 'Radiohead', sortName: 'Radiohead', status: 'continuing', monitored: true, images: [], tags: [], path: '/music/Radiohead', qualityProfileId: 11 },
    };
    musicApi({ '/api/v1/calendar': [item] });
    renderAt('/calendar');
    const bar = await screen.findByRole('button', { name: /^Music: Radiohead, New Album/ });
    expect(bar.getAttribute('data-tone')).toBe('upcoming');
    expect(within(bar).getByText('Music')).toBeTruthy();
    fireEvent.click(bar);
    const pop = await screen.findByRole('dialog');
    expect(within(pop).getByText('Music')).toBeTruthy();
    expect(within(pop).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/library/music/album/8');
    fireEvent.keyDown(pop, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Agenda' }));
    const day = await screen.findByRole('region', { name: /October 20, 2026/ });
    expect(within(day).getByText('Music', { selector: '.al-chip' })).toBeTruthy();
  });
});

describe('settings', () => {
  it('turns music on from Settings → General; audiobooks is marked coming soon', async () => {
    const api = musicApi({
      '/api/v1/settings/metadata': { tmdbApiKey: null, language: 'en-US', region: 'US' },
      'PUT /api/v1/settings/features': FEATURES_ON,
    }, FEATURES_OFF);
    renderAt('/settings/general');
    const music = await screen.findByRole('switch', { name: /^Music/ });
    expect((screen.getByRole('switch', { name: /Audiobooks/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Coming soon')).toBeTruthy();
    fireEvent.click(music);
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/settings/features')?.body).toEqual(FEATURES_ON));
  });

  it('edits MusicBrainz settings and keeps the masked Fanart key', async () => {
    const api = musicApi({
      '/api/v1/settings/metadata': { tmdbApiKey: null, language: 'en-US', region: 'US' },
      '/api/v1/settings/musicmetadata': { baseUrl: 'https://musicbrainz.org/ws/2/', contactEmail: null, rateLimitPerSecond: 1, fanartApiKey: '********', preferredCountries: ['XW', 'US'], preferredFormats: ['Digital Media', 'CD'] },
      'PUT /api/v1/settings/musicmetadata': (init: RequestInit | undefined) => ({ fanartApiKey: '********', contactEmail: null, ...(JSON.parse(String(init?.body)) as object) }),
    });
    renderAt('/settings/general');
    const section = await screen.findByRole('region', { name: 'Music metadata' });
    const countries = await within(section).findByLabelText('Preferred countries');
    fireEvent.change(countries, { target: { value: 'gb, xw' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/settings/musicmetadata')).toBeTruthy());
    const body = api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/settings/musicmetadata')!.body as Record<string, unknown>;
    expect(body.preferredCountries).toEqual(['GB', 'XW']);
    expect('fanartApiKey' in body).toBe(false);
  });

  it('accepts music root folders and labels them', async () => {
    musicApi({ '/api/v1/settings/mediamanagement': {}, '/api/v1/config/naming': {} });
    renderAt('/settings/mediamanagement');
    const list = await screen.findByRole('list', { name: 'Root folders' });
    const rows = within(list).getAllByTestId('root-folder-row');
    expect(rows.map((r) => r.querySelector('.al-root-row__kind')?.textContent)).toEqual(['Series', 'Music']);
  });

  it('lists album-type profiles under Profiles and saves a new one', async () => {
    const api = musicApi({
      '/api/v1/customformat': [],
      '/api/v1/delayprofile': [],
      '/api/v1/releaseprofile': [],
      'POST /api/v1/albumtypeprofile': { id: 3, name: 'Live too', primaryTypes: ['Album'], secondaryTypes: ['Live'], releaseStatuses: ['Official'], isDefault: false },
    });
    renderAt('/settings/profiles');
    const section = await screen.findByRole('region', { name: 'Album types' });
    expect(await within(section).findByText('Studio albums')).toBeTruthy();
    fireEvent.click(within(section).getAllByRole('button', { name: 'Add album types' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add album types' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Live too' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Live' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/albumtypeprofile')?.body).toEqual({
        name: 'Live too',
        primaryTypes: ['Album'],
        secondaryTypes: ['Live'],
        releaseStatuses: ['Official'],
        isDefault: false,
      }),
    );
  });
});
