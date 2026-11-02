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
