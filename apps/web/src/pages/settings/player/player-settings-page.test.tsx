import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { MediaServerConfig, PlayerSettings } from '@arclight/shared';
import { renderAt, stubApi, type FakeApi } from '../../../test/route-harness.js';
import { engineTestLine, playerEngineServers, toPlayerSettingsBody, toPlayerSettingsDraft } from './player-settings-page.js';

configure({ asyncUtilTimeout: 5000 });

const server = (over: Partial<MediaServerConfig>) => MediaServerConfig.parse({ id: 'jf1', kind: 'jellyfin', name: 'Den', url: 'http://jellyfin.test', apiKey: '********', ...over });

let api: FakeApi;
afterEach(() => vi.unstubAllGlobals());

function stub(servers: MediaServerConfig[], saved: Partial<PlayerSettings> = {}) {
  api = stubApi({
    '/api/v1/settings/player': PlayerSettings.parse({ enabled: true, ...saved }),
    'PUT /api/v1/settings/player': (init: RequestInit | undefined) => JSON.parse(String(init?.body)),
    'POST /api/v1/settings/player/engine-test': { ok: true, serverId: 'jf1', serverName: 'Den', version: '10.10.0', sample: { fileId: 1, resolved: true, itemId: 'x' }, message: null },
    '/api/v1/mediaserver': servers,
    '/api/v1/settings/player/trickplay-cache': { bytes: 3 * 1024 ** 2, files: 12 },
    'DELETE /api/v1/settings/player/trickplay-cache': () => null,
    'POST /api/v1/jobs/run': { id: 7, name: 'player-segments', status: 'queued', trigger: 'manual', message: null, queuedAt: '2026-05-01T00:00:00.000Z', startedAt: null, endedAt: null, durationMs: null },
  });
}

describe('Settings -> Player -> Playback engine', () => {
  it('round-trips the engine through the draft ("" is the first server)', () => {
    const defaults = PlayerSettings.parse({});
    expect(defaults).toMatchObject({ backend: 'arclight', jellyfinServerId: null });
    expect(toPlayerSettingsBody(toPlayerSettingsDraft(defaults))).toEqual({ ok: true, body: defaults });
    const chosen = PlayerSettings.parse({ backend: 'jellyfin', jellyfinServerId: 'jf1' });
    expect(toPlayerSettingsBody(toPlayerSettingsDraft(chosen))).toEqual({ ok: true, body: chosen });
  });

  it('offers enabled Jellyfin and Emby servers only and words test results', () => {
    const list = [server({}), server({ id: 'e', kind: 'emby', name: 'E' }), server({ id: 'p', kind: 'plex', name: 'P' }), server({ id: 'off', enabled: false, name: 'Off' })];
    expect(playerEngineServers(list).map((s) => s.id)).toEqual(['jf1', 'e']);
    expect(engineTestLine({ ok: false, serverId: null, serverName: null, version: null, sample: null, message: 'nope' })).toBe('Test failed: nope');
  });

  it('disables Jellyfin with a hint while no Jellyfin/Emby server is set up', async () => {
    stub([server({ kind: 'plex', name: 'Plex' })]);
    renderAt('/settings/player');
    const jellyfin = (await screen.findByRole('button', { name: 'Jellyfin' })) as HTMLButtonElement;
    await waitFor(() => expect(jellyfin.disabled).toBe(true));
    expect(screen.getByText(/add a Jellyfin or Emby server under Settings > Media servers/)).toBeTruthy();
  });

  it('picks Jellyfin and a server, tests it, and saves the choice', async () => {
    stub([server({}), server({ id: 'e2', kind: 'emby', name: 'Attic' })]);
    renderAt('/settings/player');
    const jellyfin = (await screen.findByRole('button', { name: 'Jellyfin' })) as HTMLButtonElement;
    await waitFor(() => expect(jellyfin.disabled).toBe(false));
    fireEvent.click(jellyfin);
    const select = (await screen.findByLabelText('Jellyfin server')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'e2' } });

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Connected to Den 10.10.0. It found a sample file.')).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/v1/settings/player/engine-test')?.body).toEqual({ jellyfinServerId: 'e2' });

    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ backend: 'jellyfin', jellyfinServerId: 'e2' });
  });
});

describe('Settings -> Player -> Movies & TV', () => {
  it('round-trips the switch and slot limits, and names a bad slot field', () => {
    const s = PlayerSettings.parse({ video: false, videoMaxStreams: 5, videoMaxStreamsPerUser: 2 });
    expect(toPlayerSettingsBody(toPlayerSettingsDraft(s))).toEqual({ ok: true, body: s });
    const bad = toPlayerSettingsBody({ ...toPlayerSettingsDraft(s), videoMaxStreamsPerUser: '0' });
    expect(bad).toMatchObject({ ok: false, field: 'videoMaxStreamsPerUser' });
  });

  it('turns Movies & TV off and changes the live video slots', async () => {
    stub([]);
    renderAt('/settings/player');
    const toggle = (await screen.findByLabelText('Movies & TV')) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText('Live video slots'), { target: { value: '4' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ video: false, videoMaxStreams: 4, videoMaxStreamsPerUser: 1 });
  });
});

describe('Settings -> Player -> Scrub thumbnails and intros', () => {
  it('round-trips the scrub-thumbnail mode and detection switch', () => {
    const s = PlayerSettings.parse({ trickplay: 'library', segmentDetection: false });
    expect(toPlayerSettingsBody(toPlayerSettingsDraft(s))).toEqual({ ok: true, body: s });
  });

  it('shows the cache, clears it, scans now and saves the choices', async () => {
    stub([]);
    renderAt('/settings/player');
    expect(await screen.findByText('3.0 MB in 12 files')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear scrub thumbnails' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/settings/player/trickplay-cache')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Scan now' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/jobs/run')).toBe(true));
    expect(api.calls.find((c) => c.path === '/api/v1/jobs/run')!.body).toEqual({ name: 'player-segments' });

    fireEvent.change(screen.getByLabelText('Scrub thumbnails'), { target: { value: 'off' } });
    fireEvent.click(screen.getByLabelText('Detect intros and credits'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ trickplay: 'off', segmentDetection: false });
  });

  it('recaps are on by default, turn off on their own, and wait for detection', async () => {
    const s = PlayerSettings.parse({});
    expect(s.segmentDetectionRecaps).toBe(true);
    const off = PlayerSettings.parse({ segmentDetectionRecaps: false });
    expect(toPlayerSettingsBody(toPlayerSettingsDraft(off))).toEqual({ ok: true, body: off });

    stub([]);
    renderAt('/settings/player');
    const recaps = (await screen.findByLabelText('Detect recaps')) as HTMLInputElement;
    expect(recaps.checked).toBe(true);
    expect(recaps.disabled).toBe(false);
    fireEvent.click(recaps);
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ segmentDetection: true, segmentDetectionRecaps: false });

    // With detection off the recaps switch shows off and cannot be changed.
    fireEvent.click(screen.getByLabelText('Detect intros and credits'));
    expect(recaps.checked).toBe(false);
    expect(recaps.disabled).toBe(true);
  });
});
