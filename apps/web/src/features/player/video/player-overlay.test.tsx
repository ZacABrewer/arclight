import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { trickplayTileAt, type TrickplayManifest } from '@arclight/shared';
import { api, renderBrowse, stubFetch, type Call } from '../browse/test-utils.js';
import { HIDE_AFTER_MS, PAUSE_SCREEN_AFTER_MS, ScrubPreview, UP_NEXT_LEAD_MS, upNextStart } from './player-page.js';
import { session, videoItem } from './test-fixtures.js';

// The overlay's timers (redesign spec §5.1–5.6): the pause screen, the scrub preview and the
// up-next countdown, on fake timers. Real time still flows so waitFor and the queries work.

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sessions = (calls: Call[]) => calls.filter((c) => c.path === api('/video/session'));
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

function video(): HTMLVideoElement {
  const el = document.querySelector('video');
  if (!el) throw new Error('no video element');
  return el;
}

/** Move the element's clock and tell the controller. */
function timeTo(el: HTMLVideoElement, seconds: number) {
  Object.defineProperty(el, 'currentTime', { configurable: true, writable: true, value: seconds });
  fireEvent(el, new Event('timeupdate'));
}

describe('pause screen', () => {
  function start() {
    const key = 'movie:7';
    const calls = stubFetch({
      [api(`/item/${encodeURIComponent(key)}`)]: videoItem({
        overview: 'An example overview.',
        pause: { title: 'Movie 7', episodeTitle: null, seasonNumber: null, episodeNumber: null, year: 2021, certification: 'PG-13', tmdbScore: 7.4, genres: ['Drama'], overview: 'An example overview.', logoUrl: null, backdropUrl: null, chips: null },
      } as never),
      [api('/progress')]: { items: [] },
      [`POST ${api('/video/session')}`]: () => session(),
      [`PUT ${api('/progress/movie%3A7')}`]: null,
    });
    renderBrowse(`/player/watch/play/${key}`);
    return calls;
  }

  it('shows after 6 s paused, with the title, overview and "Ends at", and a pointer move dismisses it', async () => {
    const calls = start();
    await waitFor(() => expect(sessions(calls)).toHaveLength(1));
    await screen.findByRole('slider', { name: 'Seek' });
    fireEvent(video(), new Event('playing'));
    fireEvent(video(), new Event('pause'));
    await advance(PAUSE_SCREEN_AFTER_MS - 100);
    expect(screen.queryByTestId('pause-screen')).toBeNull();
    await advance(200);
    const pause = await screen.findByTestId('pause-screen');
    expect(pause.textContent).toContain('Movie 7');
    expect(pause.textContent).toContain('An example overview.');
    expect(pause.textContent).toMatch(/Ends at /);
    fireEvent.pointerMove(pause.closest('.vp') ?? pause);
    await waitFor(() => expect(screen.queryByTestId('pause-screen')).toBeNull());
  });

  it('never shows while playing; the controls hide after 5 s instead', async () => {
    const calls = start();
    await waitFor(() => expect(sessions(calls)).toHaveLength(1));
    await screen.findByRole('slider', { name: 'Seek' });
    fireEvent(video(), new Event('playing'));
    const root = video().closest('.vp')!;
    expect(root.classList.contains('vp--idle')).toBe(false);
    await advance(HIDE_AFTER_MS + 100);
    await waitFor(() => expect(root.classList.contains('vp--idle')).toBe(true));
    await advance(PAUSE_SCREEN_AFTER_MS);
    expect(screen.queryByTestId('pause-screen')).toBeNull();
  });
});

describe('ScrubPreview', () => {
  const manifest: TrickplayManifest = {
    mediaFileId: 501,
    status: 'ready',
    intervalMs: 10_000,
    tileWidth: 320,
    tileHeight: 180,
    columns: 5,
    rows: 5,
    tileCount: 60,
    sheets: ['https://example.com/t/0.jpg', 'https://example.com/t/1.jpg', 'https://example.com/t/2.jpg'],
  };
  const chapters = [
    { title: 'Opening', startMs: 0, durationMs: 200_000 },
    { title: 'The Middle', startMs: 200_000, durationMs: 400_000 },
  ];

  it('shows the 240x135 tile for the time, the time and the chapter', () => {
    const ms = 264_000;
    render(<ScrubPreview ms={ms} durationMs={600_000} chapters={chapters} manifest={manifest} />);
    const tile = trickplayTileAt(manifest, ms);
    const thumb = screen.getByTestId('scrub-thumb');
    const scale = 240 / manifest.tileWidth;
    expect(tile.sheet).toBe(1);
    expect(thumb.style.backgroundImage).toContain('1.jpg');
    expect(thumb.style.backgroundPosition).toBe(`${-tile.x * scale}px ${-tile.y * scale}px`);
    expect(thumb.style.backgroundSize).toBe(`${5 * 320 * scale}px ${5 * 180 * (135 / 180)}px`);
    const preview = screen.getByTestId('scrub-preview');
    expect(preview.textContent).toContain('4:24');
    expect(preview.textContent).toContain('The Middle');
  });

  it('shows only the time and chapter without a ready manifest', () => {
    render(<ScrubPreview ms={30_000} durationMs={600_000} chapters={chapters} manifest={null} />);
    expect(screen.queryByTestId('scrub-thumb')).toBeNull();
    expect(screen.getByTestId('scrub-preview').textContent).toContain('0:30');
    expect(screen.getByTestId('scrub-preview').textContent).toContain('Opening');
  });
});

describe('up next', () => {
  it('starts at the credits in the second half, else 20 s before the end', () => {
    expect(upNextStart([{ type: 'credits', startMs: 540_000, endMs: 600_000 } as never], 600_000)).toBe(540_000);
    expect(upNextStart([{ type: 'credits', startMs: 10_000, endMs: 20_000 } as never], 600_000)).toBe(600_000 - UP_NEXT_LEAD_MS);
    expect(upNextStart([], 600_000)).toBe(580_000);
  });

  function start(settings?: Record<string, unknown>) {
    const key = 'episode:42';
    const calls = stubFetch({
      [api(`/item/${encodeURIComponent(key)}`)]: videoItem({ itemKey: key, kind: 'episode', title: 'Episode two', context: 'Show 3', seriesId: 3, seasonNumber: 1, episodeNumber: 2, next: 'episode:43', movieId: undefined } as never),
      [api('/progress')]: { items: [] },
      [`POST ${api('/video/session')}`]: () => session({ itemKey: key }),
      [`PUT ${api('/progress/episode%3A42')}`]: null,
      ...(settings ? { '/api/v1/households/profiles/active/settings': settings } : {}),
    });
    const r = renderBrowse(`/player/watch/play/${key}`);
    return { calls, ...r };
  }

  it('counts down 10 s near the end and plays the next episode at 0', async () => {
    const { calls, router } = start();
    await waitFor(() => expect(sessions(calls)).toHaveLength(1));
    await screen.findByRole('slider', { name: 'Seek' });
    fireEvent(video(), new Event('playing'));
    timeTo(video(), 585);
    expect(await screen.findByText('Next episode in 10s')).toBeTruthy();
    await advance(1000);
    expect(await screen.findByText('Next episode in 9s')).toBeTruthy();
    // Paused: the countdown holds.
    fireEvent(video(), new Event('pause'));
    await advance(3000);
    expect(screen.getByText('Next episode in 9s')).toBeTruthy();
    fireEvent(video(), new Event('playing'));
    for (let i = 0; i < 9; i++) await advance(1000);
    await waitFor(() => expect(router.state.location.pathname).toBe('/player/watch/play/episode:43'));
  });

  it('shows Play now with no countdown when autoplay next episode is off', async () => {
    const { calls, router } = start({ autoplayNext: false });
    await waitFor(() => expect(sessions(calls)).toHaveLength(1));
    await screen.findByRole('slider', { name: 'Seek' });
    fireEvent(video(), new Event('playing'));
    timeTo(video(), 585);
    expect(await screen.findByRole('button', { name: /Play now/i })).toBeTruthy();
    await advance(12_000);
    expect(screen.queryByText(/Next episode in/)).toBeNull();
    expect(router.state.location.pathname).toBe('/player/watch/play/episode:42');
  });
});
