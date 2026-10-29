import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Permission, type AudioDiscoverItem, type AudioRequest } from '@arclight/shared';
import { authRoutes, renderAt, stubApi, user } from '../../features/requests/test-utils.js';
import { audioRequestBlocker, audioTarget } from './audio-kit.js';
import { discoverPath } from '../../features/discover/base.js';

afterEach(() => vi.unstubAllGlobals());

const features = (music: boolean, audiobooks = false) => ({ '/api/v1/settings/features': { music, audiobooks } });

function album(over: Partial<AudioDiscoverItem> = {}): AudioDiscoverItem {
  return {
    kind: 'album',
    foreignId: 'rg-1',
    title: 'Blue Shore',
    subtitle: 'The Example Band',
    year: 2020,
    coverUrl: null,
    detail: 'Album',
    parentForeignId: 'ar-1',
    mediaStatus: 'unknown',
    ...over,
  };
}

function book(over: Partial<AudioDiscoverItem> = {}): AudioDiscoverItem {
  return { kind: 'book', foreignId: 'B000TEST01', title: 'Quiet Harbour', subtitle: 'Ada Writer', year: 2019, mediaStatus: 'unknown', region: 'us', ...over };
}

function audioRequest(over: Partial<AudioRequest> = {}): AudioRequest {
  return {
    id: 7,
    kind: 'album',
    status: 'pending',
    foreignId: 'rg-1',
    title: 'Blue Shore',
    subtitle: 'The Example Band',
    year: 2020,
    requestedBy: { id: 2, username: 'amy' },
    modifiedBy: null,
    mediaStatus: 'pending',
    canRemove: true,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...over,
  };
}

describe('audio discover helpers', () => {
  it('links cards to their pages, region included for books', () => {
    expect(discoverPath('/discover', audioTarget(album()))).toBe('/discover/music/album/rg-1');
    expect(discoverPath('/portal', audioTarget({ kind: 'artist', foreignId: 'ar-1' }))).toBe('/portal/music/artist/ar-1');
    expect(audioTarget(book())).toMatchObject({ to: '/audiobooks/book/$asin', search: { region: 'us' } });
  });

  it('says why an item cannot be requested', () => {
    const ok = { signedIn: true, allowed: true };
    expect(audioRequestBlocker(album(), ok)).toBeNull();
    expect(audioRequestBlocker(album({ requestStatus: 'declined' }), ok)).toBeNull();
    expect(audioRequestBlocker(album(), { signedIn: false, allowed: true })).toBe('Sign in to request');
    expect(audioRequestBlocker(album(), { signedIn: true, allowed: false })).toBe('Your account cannot request music');
    expect(audioRequestBlocker(book(), { signedIn: true, allowed: false })).toBe('Your account cannot request audiobooks');
    expect(audioRequestBlocker(album({ mediaStatus: 'available' }), ok)).toBe('Already in the library');
    expect(audioRequestBlocker(album({ requestStatus: 'pending' }), ok)).toBe('Already requested');
  });
});

describe('music in Discover', () => {
  it('renders the home sections with square cards and status chips', async () => {
    stubApi({
      ...features(true),
      '/api/v1/discover/music': {
        sections: [
          { id: 'music-fresh', title: 'Fresh releases', items: [album(), album({ foreignId: 'rg-2', title: 'Red Hill', mediaStatus: 'available' })] },
          { id: 'music-empty', title: 'Nothing', items: [] },
        ],
      },
    });
    renderAt('/discover/music');
    const section = await screen.findByRole('region', { name: 'Fresh releases' });
    const card = within(section).getByRole('article', { name: 'Blue Shore' });
    expect(card.classList.contains('dk-card--square')).toBe(true);
    expect(within(card).getAllByRole('link')[0]!.getAttribute('href')).toBe('/discover/music/album/rg-1');
    const owned = within(section).getByRole('article', { name: 'Red Hill' });
    expect(within(owned).getByText('Available')).toBeTruthy();
    expect((within(owned).getByRole('button', { name: /Request/ }) as HTMLButtonElement).disabled).toBe(true);
    // Empty sections are skipped.
    expect(screen.queryByRole('region', { name: 'Nothing' })).toBeNull();
  });

  it('requests an album after the confirm dialog and refreshes the card', async () => {
    let requested = false;
    const calls = stubApi({ ...features(true) }, (url, method) => {
      if (url === '/api/v1/discover/music') {
        return { body: { sections: [{ id: 'music-top', title: 'Top albums', items: [album(requested ? { requestStatus: 'pending', mediaStatus: 'pending', requestId: 7 } : {})] }] } };
      }
      if (url === '/api/v1/audiorequest' && method === 'POST') {
        requested = true;
        return { status: 201, body: audioRequest() };
      }
      return undefined;
    });
    const { toasts } = renderAt('/discover/music');
    const card = await screen.findByRole('article', { name: 'Blue Shore' });
    fireEvent.click(within(card).getByRole('button', { name: 'Request Blue Shore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request Blue Shore' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/audiorequest' && c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.url === '/api/v1/audiorequest' && c.method === 'POST')?.body).toEqual({ kind: 'album', foreignId: 'rg-1' });
    await waitFor(() => expect(toasts.list().map((x) => x.title)).toContain('Requested Blue Shore'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The home refetches: the card now says Requested and its button is disabled.
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Blue Shore' })).getByText('Requested')).toBeTruthy());
    expect((within(screen.getByRole('article', { name: 'Blue Shore' })).getByRole('button', { name: /Request/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows "Music is turned off" when the flag is off', async () => {
    const calls = stubApi({ ...features(false) });
    renderAt('/discover/music');
    expect(await screen.findByText('Music is turned off')).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith('/api/v1/discover/music'))).toBe(false);
  });

  it('album page shows the tracklist, the artist link and more by the artist', async () => {
    stubApi({
      ...features(true),
      '/api/v1/discover/music/album/rg-1': {
        item: album(),
        artistName: 'The Example Band',
        artistForeignId: 'ar-1',
        overview: 'A record.',
        genres: ['Rock'],
        tracks: [
          { position: '1', title: 'Opening', durationMs: 221_000 },
          { position: '2', title: 'Closing', durationMs: 62_000 },
        ],
        moreByArtist: [album({ foreignId: 'rg-9', title: 'Older Record' })],
      },
    });
    renderAt('/discover/music/album/rg-1');
    expect(await screen.findByRole('heading', { level: 1, name: /Blue Shore/ })).toBeTruthy();
    const tracks = screen.getByRole('table', { name: 'Tracklist' });
    expect(within(tracks).getByText('Opening')).toBeTruthy();
    expect(within(tracks).getByText('3:41')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'The Example Band' }).getAttribute('href')).toBe('/discover/music/artist/ar-1');
    const more = screen.getByRole('region', { name: 'More by The Example Band' });
    expect(within(more).getByRole('article', { name: 'Older Record' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Request Blue Shore' }).length).toBeGreaterThan(0);
  });

  it('artist page offers "Request artist" and per-album requests', async () => {
    stubApi({
      ...features(true),
      '/api/v1/discover/music/artist/ar-1': {
        item: { kind: 'artist', foreignId: 'ar-1', title: 'The Example Band', mediaStatus: 'unknown' },
        genres: [],
        albums: [album(), album({ foreignId: 'rg-2', title: 'Red Hill' })],
      },
    });
    renderAt('/discover/music/artist/ar-1');
    expect(await screen.findByRole('button', { name: 'Request The Example Band' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request The Example Band' }).textContent).toBe('Request artist');
    const grid = screen.getByRole('region', { name: 'Albums' });
    expect(within(grid).getAllByRole('article')).toHaveLength(2);
    expect(within(grid).getByRole('button', { name: 'Request Red Hill' })).toBeTruthy();
  });

  it('disables Request with the reason for a user without the music permission', async () => {
    stubApi({
      ...features(true),
      ...authRoutes(user({ permissions: Permission.REQUEST_AUDIOBOOK })),
      '/api/v1/discover/music/album/rg-1': { item: album(), artistName: 'The Example Band', artistForeignId: 'ar-1', genres: [], tracks: [], moreByArtist: [] },
    });
    renderAt('/discover/music/album/rg-1');
    const button = (await screen.findByRole('button', { name: /Request \(Your account cannot request music\)/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('Your account cannot request music')).toBeTruthy();
  });

  it('Discover home links Music and Audiobooks only while their flags are on', async () => {
    stubApi({ ...features(true, false), '/api/v1/discoverslider': [] });
    renderAt('/discover');
    const browse = await screen.findByRole('navigation', { name: 'Browse' });
    expect((await within(browse).findByRole('link', { name: 'Music' })).getAttribute('href')).toBe('/discover/music');
    expect(within(browse).queryByRole('link', { name: 'Audiobooks' })).toBeNull();
  });
});

describe('audiobooks in Discover', () => {
  it('book page links authors and shows narrators, runtime and series', async () => {
    stubApi({
      ...features(false, true),
      '/api/v1/discover/audiobooks/book/B000TEST01': {
        item: book(),
        authors: [{ name: 'Ada Writer', foreignId: 'A000AUTH01' }, { name: 'Co Author' }],
        narrators: ['Sam Reader'],
        overview: 'A story.',
        runtimeMinutes: 684,
        series: [{ name: 'Harbour', position: '2' }],
        genres: ['Fiction'],
        moreByAuthor: [],
      },
    });
    renderAt('/discover/audiobooks/book/B000TEST01?region=us');
    expect(await screen.findByRole('heading', { level: 1, name: /Quiet Harbour/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ada Writer' }).getAttribute('href')).toBe('/discover/audiobooks/author/A000AUTH01?region=us');
    expect(screen.getByText('Sam Reader')).toBeTruthy();
    expect(screen.getByText('Harbour #2')).toBeTruthy();
    expect(screen.getByText('11 h 24 min')).toBeTruthy();
  });
});
