import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, screen, within } from '@testing-library/react';
import { ActiveStream } from '@arclight/shared';
import { renderAt, stubApi } from '../../test/route-harness.js';
import { clockOf, playbackDetail, streamTitle } from './streams-page.js';

configure({ asyncUtilTimeout: 5000 });

const stream = (over: Partial<ActiveStream> = {}): ActiveStream =>
  ActiveStream.parse({
    id: 's1',
    state: 'playing',
    startedAt: '2026-10-25T10:00:00.000Z',
    lastSeenAt: '2026-10-25T10:05:00.000Z',
    user: { id: 2, username: 'casey' },
    profile: { id: 9, name: 'Kids', color: '#3a7bd5', initial: 'K', isOwner: false },
    item: { itemKey: 'episode:4', kind: 'episode', title: 'Pilot', seriesTitle: 'Test Show', seasonNumber: 1, episodeNumber: 2, artist: null, album: null, chapter: null, year: 2020, artworkUrl: null },
    positionMs: 754_000,
    durationMs: 2_700_000,
    client: { kind: 'tv', deviceName: 'Living room TV', platform: 'android', appVersion: '0.25.0' },
    address: { ip: '198.51.100.20', remote: true },
    playback: { method: 'transcode', delivery: 'hls', backend: 'arclight', reasons: ['video-codec'], rung: { id: '1080', height: 1080, videoKbps: 8000, codec: 'h264' }, hwaccel: 'qsv', encodeSpeed: 1.4, audioFormat: null, bitrateKbps: 8000 },
    ...over,
  });

afterEach(() => vi.unstubAllGlobals());

describe('Activity -> Now playing', () => {
  it('shows who, what, the client, the address, how it plays and where it is', async () => {
    const api = stubApi({
      '/api/v1/activity/streams': {
        streams: [
          stream(),
          stream({
            id: 's2',
            state: 'paused',
            positionMs: 65_000,
            durationMs: 200_000,
            profile: { id: 1, name: 'admin', color: '#d53a3a', initial: 'A', isOwner: true },
            user: { id: 1, username: 'admin' },
            item: { itemKey: 'track:3', kind: 'track', title: 'Song 1', seriesTitle: null, seasonNumber: null, episodeNumber: null, artist: 'The Testers', album: 'Sample Record', chapter: null, year: null, artworkUrl: null },
            client: { kind: 'web', deviceName: 'Firefox', platform: null, appVersion: null },
            address: { ip: '127.0.0.1', remote: false },
            playback: { method: 'direct', delivery: 'progressive', backend: 'arclight', reasons: [], rung: null, hwaccel: null, encodeSpeed: null, audioFormat: null, bitrateKbps: 900 },
          }),
        ],
        idleSec: 90,
        pausedIdleSec: 600,
      },
    });
    renderAt('/activity/streams');
    const table = await screen.findByRole('table', { name: 'Now playing' });
    const mains = [...table.querySelectorAll('.al-activity-title__main')].map((e) => e.textContent);
    expect(mains).toEqual(expect.arrayContaining(['Test Show', 'Song 1', 'Kids', 'Living room TV', 'Firefox']));
    expect(within(table).getByText('S01E02 · Pilot')).toBeTruthy();
    expect(within(table).getByText('casey')).toBeTruthy();
    expect(within(table).getByText('TV · Android · 0.25.0')).toBeTruthy();
    expect(within(table).getByText('198.51.100.20')).toBeTruthy();
    expect(within(table).getByText('Remote')).toBeTruthy();
    expect(within(table).getByText('Transcode')).toBeTruthy();
    expect(within(table).getByText('1080p · 8000 kbps · Intel Quick Sync (QSV) · 1.4× · HLS')).toBeTruthy();
    expect(within(table).getByText('12:34 / 45:00')).toBeTruthy();
    expect(within(table).getByRole('progressbar', { name: 'Position in Test Show' })).toBeTruthy();
    // The owner profile row: no second name line, the track's artist and album.
    expect(within(table).getByText('The Testers · Sample Record')).toBeTruthy();
    expect(within(table).getByText('Paused')).toBeTruthy();
    expect(within(table).getByText('1:05 / 3:20')).toBeTruthy();
    expect(within(table).getByText('Local')).toBeTruthy();
    expect(within(table).getByText('Direct play')).toBeTruthy();
    expect(within(table).getAllByText('admin')).toHaveLength(1);
    expect(screen.getByText('2 streams')).toBeTruthy();
    // View only: no buttons in the rows.
    expect(within(table).queryAllByRole('button')).toHaveLength(0);
    expect(api.calls.some((c) => c.path === '/api/v1/activity/streams')).toBe(true);
  });

  it('says so when nothing plays', async () => {
    stubApi({ '/api/v1/activity/streams': { streams: [], idleSec: 90, pausedIdleSec: 600 } });
    renderAt('/activity/streams');
    expect(await screen.findByText('Nothing is playing')).toBeTruthy();
  });

  it('formats titles, playback and times', () => {
    expect(clockOf(65_000)).toBe('1:05');
    expect(clockOf(3_723_000)).toBe('1:02:03');
    const book = stream({ item: { itemKey: 'audiobook:1', kind: 'audiobook', title: 'Long Story', seriesTitle: null, seasonNumber: null, episodeNumber: null, artist: 'A. Writer', album: null, chapter: 'The Middle', year: null, artworkUrl: null } }).item;
    expect(streamTitle(book)).toEqual({ main: 'Long Story', sub: 'The Middle · A. Writer' });
    const movie = stream({ item: { itemKey: 'movie:1', kind: 'movie', title: 'Big Film', seriesTitle: null, seasonNumber: null, episodeNumber: null, artist: null, album: null, chapter: null, year: 2021, artworkUrl: null } }).item;
    expect(streamTitle(movie)).toEqual({ main: 'Big Film', sub: '2021' });
    expect(playbackDetail({ method: 'transcode', delivery: 'progressive', backend: 'jellyfin', reasons: [], rung: null, hwaccel: null, encodeSpeed: null, audioFormat: 'opus', bitrateKbps: 128 })).toBe('OPUS · 128 kbps · via Jellyfin/Emby');
  });
});
