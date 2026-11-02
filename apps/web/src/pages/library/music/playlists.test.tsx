import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SECRET_MASK, type MediaServerResource, type MusicPlaylist, type MusicPlaylistEntry, type MusicPlaylistsSettingsResponse } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { navFor, sectionTabs } from '../../../nav.js';
import { playlistSettingsChanges } from './playlists.js';
import { availability, sourceDraft, sourceFromDraft, sourceSummary, targetLabel } from './playlists-model.js';
import { FEATURES_ON, makeArtist, makeArtistDetails, musicProfiles, musicRoots } from './music-fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const playlist = (over: Partial<MusicPlaylist> = {}): MusicPlaylist => ({
  id: 1,
  name: 'Weekly mix',
  source: { kind: 'deezer', url: 'https://www.deezer.com/playlist/42' },
  want: 'albums',
  addArtists: false,
  rootFolderPath: null,
  qualityProfileId: null,
  searchOnWant: false,
  writeM3u: true,
  targets: ['server:jf1'],
  syncIntervalHours: 24,
  enabled: true,
  sourceTitle: 'Example Mix',
  lastSyncAt: '2026-10-30T10:00:00.000Z',
  lastSyncStatus: 'partial',
  lastSyncMessage: '1 track not found on MusicBrainz',
  counts: { total: 4, matched: 3, available: 2, wanted: 1 },
  createdAt: '2026-10-01T10:00:00.000Z',
  ...over,
});

const entry = (over: Partial<MusicPlaylistEntry>): MusicPlaylistEntry => ({
  position: 1,
  title: 'First',
  artist: 'Example Band',
  album: 'Example Album',
  durationMs: 200_000,
  isrc: null,
  status: 'available',
  matchMethod: 'isrc',
  recordingMbid: null,
  releaseGroupMbid: null,
  artistMbid: null,
  artistId: 1,
  albumId: 3,
  trackId: 9,
  albumTitle: 'Example Album',
  artistName: 'Example Band',
  ...over,
});

const settings: MusicPlaylistsSettingsResponse = {
  spotifyClientId: '',
  spotifyClientSecret: '',
  lastfmApiKey: SECRET_MASK,
  m3uFolder: '',
  m3uPaths: 'relative',
  navidromeUrl: '',
  navidromeUser: '',
  navidromePassword: '',
  similarSource: 'both',
  maxSearchesPerSync: 200,
};

const jellyfin = { id: 'jf1', kind: 'jellyfin', name: 'Living room', url: 'http://jellyfin.example.com:8096', apiKey: SECRET_MASK, enabled: true, usedForAvailability: true, usedForRetention: false, usedForRefresh: false, loginEnabled: false, createUsersOnLogin: false } as MediaServerResource;

function api(extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/settings/features': FEATURES_ON,
    '/api/v1/qualityprofile': musicProfiles,
    '/api/v1/rootfolder': musicRoots,
    '/api/v1/tag': [],
    '/api/v1/mediaserver': [jellyfin],
    '/api/v1/music/playlist': [playlist()],
    '/api/v1/settings/musicplaylists': settings,
    ...extra,
  });
}

describe('playlists model', () => {
  it('builds sources from the form and refuses incomplete ones', () => {
    expect(sourceFromDraft({ ...sourceDraft(), kind: 'spotify', url: '  ' })).toBeNull();
    expect(sourceFromDraft({ ...sourceDraft(), kind: 'deezer', url: ' https://www.deezer.com/playlist/42 ' })).toEqual({ kind: 'deezer', url: 'https://www.deezer.com/playlist/42' });
    expect(sourceFromDraft({ ...sourceDraft(), kind: 'lastfm', user: 'example', limit: 999 })).toEqual({ kind: 'lastfm', user: 'example', chart: 'top', period: '3month', limit: 200 });
    const lb = { kind: 'listenbrainzCreatedFor', user: 'example', patch: 'weekly-jams' } as const;
    expect(sourceFromDraft(sourceDraft(lb))).toEqual(lb);
    expect(sourceSummary(lb)).toBe('example · weekly-jams');
  });

  it('labels targets and availability', () => {
    expect(targetLabel('server:jf1', [jellyfin])).toBe('Living room');
    expect(targetLabel('navidrome', [])).toBe('Navidrome');
    expect(availability(playlist())).toEqual({ have: 2, total: 4, percent: 50 });
    expect(availability(playlist({ counts: { total: 0, matched: 0, available: 0, wanted: 0 } })).percent).toBe(0);
  });

  it('sends only changed settings, so masked secrets stay put', () => {
    expect(playlistSettingsChanges(settings, { ...settings, m3uFolder: '/data/playlists' })).toEqual({ m3uFolder: '/data/playlists' });
    expect(playlistSettingsChanges(settings, settings)).toEqual({});
  });

  it('lists the page under Library for admins only', () => {
    const tabs = (admin: boolean) => sectionTabs('/library/music', admin, navFor(FEATURES_ON)).map((t) => t.to);
    expect(tabs(true)).toContain('/library/music/playlists');
    expect(tabs(false)).not.toContain('/library/music/playlists');
  });
});

describe('Playlists page', () => {
  it('lists playlists with source, availability, outputs and sync state, and starts a sync', async () => {
    const fake = api({ 'POST /api/v1/music/playlist/1/sync': { jobId: 5, status: 'running' } });
    renderAt('/library/music/playlists');
    const row = (await screen.findByRole('button', { name: 'Weekly mix' })).closest('tr')!;
    expect(within(row).getByText(/Deezer · Example Mix/)).toBeTruthy();
    expect(within(row).getByText('2/4')).toBeTruthy();
    expect(within(row).getByText('.m3u8, Living room')).toBeTruthy();
    expect(within(row).getByText('Partial')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/music/playlist/1/sync')).toBe(true));
  });

  it('shows the matched entries with library links', async () => {
    api({
      '/api/v1/music/playlist/1/entries': [entry({}), entry({ position: 2, title: 'Lost', artist: 'Someone', album: null, status: 'unmatched', artistId: null, albumId: null, trackId: null, albumTitle: null, artistName: null })],
    });
    renderAt('/library/music/playlists');
    fireEvent.click(await screen.findByRole('button', { name: 'Weekly mix' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Lost')).toBeTruthy();
    expect(within(dialog).getByText('Not found')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Example Band' }).getAttribute('href')).toBe('/library/music/artist/1');
    expect(within(dialog).getByText('1 track not found on MusicBrainz')).toBeTruthy();
  });

  it('previews a source and creates a playlist with a push target', async () => {
    const fake = api({
      '/api/v1/music/playlist': [],
      'POST /api/v1/music/playlist/preview': { title: 'Example Mix', description: null, owner: 'example', trackCount: 2, tracks: [{ title: 'First', artist: 'Example Band', album: null, durationMs: null }] },
      'POST /api/v1/music/playlist': playlist({ id: 2 }),
    });
    renderAt('/library/music/playlists');
    fireEvent.click((await screen.findAllByRole('button', { name: 'New playlist' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Mix' } });
    fireEvent.change(within(dialog).getByLabelText('Source'), { target: { value: 'deezer' } });
    fireEvent.change(within(dialog).getByLabelText('Playlist link'), { target: { value: 'https://www.deezer.com/playlist/42' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    const preview = await within(dialog).findByTestId('playlist-preview');
    expect(within(preview).getByText('Example Mix')).toBeTruthy();
    expect(within(preview).getByText('Example Band – First')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Living room' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/music/playlist')?.body).toMatchObject({ name: 'Mix', source: { kind: 'deezer', url: 'https://www.deezer.com/playlist/42' }, targets: ['server:jf1'], writeM3u: true }));
  });

  it('saves only the settings that changed', async () => {
    const fake = api({ 'PUT /api/v1/settings/musicplaylists': { ...settings, m3uFolder: '/data/playlists' } });
    renderAt('/library/music/playlists');
    fireEvent.click(await screen.findByRole('button', { name: 'Sources & outputs' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Playlist folder'), { target: { value: '/data/playlists' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.calls.find((c) => c.method === 'PUT')?.body).toEqual({ m3uFolder: '/data/playlists' }));
  });
});

describe('Similar artists', () => {
  it('links library artists to their page and the rest to Add artist', async () => {
    const artist = makeArtist({ id: 1, name: 'Example Band' });
    api({
      '/api/v1/albumtypeprofile': [],
      '/api/v1/artist/1': makeArtistDetails(artist, []),
      '/api/v1/artist/1/similar': {
        items: [
          { mbid: 'a', name: 'Library Band', score: 1, source: 'both', artistId: 7 },
          { mbid: 'b', name: 'New Band', score: 0.5, source: 'listenbrainz', artistId: null },
        ],
      },
    });
    renderAt('/library/music/artist/1');
    const strip = await screen.findByRole('region', { name: 'Similar artists' });
    expect(within(strip).getByRole('link', { name: /Library Band/ }).getAttribute('href')).toBe('/library/music/artist/7');
    expect(within(strip).getByRole('link', { name: /New Band/ }).getAttribute('href')).toBe('/library/add?type=music&term=New+Band');
  });

  it('stays hidden when the lookup fails', async () => {
    const artist = makeArtist({ id: 1, name: 'Example Band' });
    api({ '/api/v1/albumtypeprofile': [], '/api/v1/artist/1': makeArtistDetails(artist, []) });
    renderAt('/library/music/artist/1');
    expect(await screen.findByRole('heading', { name: /Example Band/, level: 1 })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.music-similar')).toBeNull());
  });
});
