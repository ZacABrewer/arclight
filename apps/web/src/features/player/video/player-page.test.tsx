import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VideoSessionRequest } from '@arclight/shared';
import { api, mockPlayer, progress, renderBrowse, stubFetch, type Call } from '../browse/test-utils.js';
import { session, videoItem } from './test-fixtures.js';

// jsdom has no media playback: stub the element methods the controller calls.
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ITEM = api(`/item/${encodeURIComponent('movie:7')}`);
const sessions = (calls: Call[]) => calls.filter((c) => c.path === api('/video/session')).map((c) => c.body as VideoSessionRequest);

function routes(over: Record<string, unknown> = {}) {
  return {
    [ITEM]: videoItem(),
    [api('/progress')]: { items: [] },
    [`POST ${api('/video/session')}`]: () => session(),
    [`PUT ${api('/progress/movie%3A7')}`]: null,
    ...over,
  };
}

describe('VideoPlayerPage', () => {
  it('pauses the audio player, asks for a session with a device profile and shows the controls', async () => {
    const calls = stubFetch(routes());
    const player = mockPlayer({ playing: true });
    renderBrowse('/player/watch/play/movie:7', player);
    await waitFor(() => expect(sessions(calls)).toHaveLength(1));
    expect(player.toggle).toHaveBeenCalled();
    const req = sessions(calls)[0]!;
    expect(req.itemKey).toBe('movie:7');
    expect(req.profile.videoCodecs).toContain('h264');
    expect(req.startMs).toBeUndefined();
    expect(await screen.findByRole('heading', { name: 'Movie 7' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back 10 seconds' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Forward 10 seconds' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Audio & Subtitles' })).toBeTruthy();
  });

  it('starts at ?t= without asking', async () => {
    const calls = stubFetch(routes());
    renderBrowse('/player/watch/play/movie:7?t=90000');
    await waitFor(() => expect(sessions(calls)[0]?.startMs).toBe(90_000));
  });

  it('asks to resume between 2 % and 90 %', async () => {
    const calls = stubFetch(routes({ [api('/progress')]: { items: [progress('movie:7', { positionMs: 300_000, durationMs: 600_000 })] } }));
    renderBrowse('/player/watch/play/movie:7');
    expect(await screen.findByText('You stopped at 5:00.')).toBeTruthy();
    expect(sessions(calls)).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Resume from 5:00' }));
    await waitFor(() => expect(sessions(calls)[0]?.startMs).toBe(300_000));
  });

  it('start over ignores the saved place', async () => {
    const calls = stubFetch(routes({ [api('/progress')]: { items: [progress('movie:7', { positionMs: 300_000, durationMs: 600_000 })] } }));
    renderBrowse('/player/watch/play/movie:7');
    await userEvent.click(await screen.findByRole('button', { name: 'Start over' }));
    await waitFor(() => expect(sessions(calls)).toHaveLength(1));
    expect(sessions(calls)[0]?.startMs).toBeUndefined();
  });

  it('re-requests a live stream when seeking with the arrow keys', async () => {
    const calls = stubFetch(
      routes({
        [`POST ${api('/video/session')}`]: (_u: URL, body: unknown) =>
          session({ method: 'transcode', reasons: ['audio-codec'], seekable: false, streamStartMs: (body as VideoSessionRequest).startMs ?? 0 }),
      }),
    );
    renderBrowse('/player/watch/play/movie:7?t=60000');
    await waitFor(() => expect(sessions(calls)).toHaveLength(1));
    await screen.findByRole('heading', { name: 'Movie 7' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    await waitFor(() => expect(sessions(calls)).toHaveLength(2));
    expect(sessions(calls)[1]?.startMs).toBe(70_000);
  });

  it('shows an error for an item that is not a video', async () => {
    stubFetch(routes({ [ITEM]: videoItem({ kind: 'track', video: undefined } as never) }));
    renderBrowse('/player/watch/play/movie:7');
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't play this video.");
  });
});
