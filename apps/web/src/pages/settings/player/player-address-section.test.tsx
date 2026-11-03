import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PlayerSettings, PublicPortalSettings, RequestsSettings } from '@arclight/shared';
import { renderAt, stubApi, type FakeApi } from '../../../test/route-harness.js';
import { usedByPlayer } from '../requests/approval-policies.js';
import { checkPlayerHost, checkPlayerPath } from './player-address-section.js';

// Settings > Player > Player address: extra paths and player hostnames, refused where the
// request portal already answers.

configure({ asyncUtilTimeout: 5000 });

const portal = PublicPortalSettings.parse({ enabled: true, paths: ['/requests-here'], hosts: [{ hostname: 'requests.example.com', portalOnly: true }] });

let api: FakeApi;
afterEach(() => vi.unstubAllGlobals());

function stub(saved: Partial<PlayerSettings> = {}) {
  api = stubApi({
    '/api/v1/settings/player': PlayerSettings.parse({ enabled: true, ...saved }),
    'PUT /api/v1/settings/player': (init: RequestInit | undefined) => JSON.parse(String(init?.body)),
    '/api/v1/settings/requests': RequestsSettings.parse({ publicPortal: portal }),
    '/api/v1/mediaserver': [],
    '/api/v1/settings/player/trickplay-cache': { bytes: 0, files: 0 },
  });
}

describe('player address checks', () => {
  it('accepts a new path and refuses invalid, reserved, duplicate and portal paths', () => {
    expect(checkPlayerPath('/Watch', [], portal)).toEqual({ ok: true, path: '/watch' });
    expect(checkPlayerPath('/a b', [], portal)).toEqual({ ok: false, error: 'Use lowercase letters, numbers, - and _' });
    expect(checkPlayerPath('/settings', [], portal)).toEqual({ ok: false, error: 'This path is used by Arclight' });
    expect(checkPlayerPath('/watch', ['/watch'], portal)).toEqual({ ok: false, error: 'Already added' });
    expect(checkPlayerPath('/player', [], portal).ok).toBe(false);
    expect(checkPlayerPath('/REQUESTS-HERE', [], portal)).toEqual({ ok: false, error: 'Already used by the request portal' });
    expect(checkPlayerPath('/requests-here', [], undefined)).toEqual({ ok: true, path: '/requests-here' });
  });

  it('accepts a hostname (or a pasted URL) and refuses invalid, duplicate and portal hostnames', () => {
    expect(checkPlayerHost('Watch.Example.com.', [], portal)).toEqual({ ok: true, hostname: 'watch.example.com' });
    expect(checkPlayerHost('https://watch.example.com/player', [], portal)).toEqual({ ok: true, hostname: 'watch.example.com' });
    expect(checkPlayerHost('not a host', [], portal)).toEqual({ ok: false, error: 'Use lowercase letters, numbers, - and _' });
    expect(checkPlayerHost('watch.example.com', ['watch.example.com'], portal)).toEqual({ ok: false, error: 'Already added' });
    expect(checkPlayerHost('requests.example.com', [], portal)).toEqual({ ok: false, error: 'Already used by the request portal' });
  });
});

describe('request portal checks against the player address', () => {
  it('refuses portal paths and hostnames the player already uses', () => {
    const player = PlayerSettings.parse({ address: { paths: ['/watch'], hosts: [{ hostname: 'watch.example.com' }] } }).address;
    expect(usedByPlayer(player, { path: '/WATCH' })).toBe(true);
    expect(usedByPlayer(player, { path: '/requests' })).toBe(false);
    expect(usedByPlayer(player, { hostname: 'watch.example.com' })).toBe(true);
    expect(usedByPlayer(player, { hostname: 'requests.example.com' })).toBe(false);
    expect(usedByPlayer(undefined, { path: '/watch' })).toBe(false);
  });
});

describe('Settings -> Player -> Player address', () => {
  it('adds and removes paths and hostnames and saves them', async () => {
    stub({ address: { paths: ['/tv'], hosts: [] } });
    renderAt('/settings/player');
    const paths = await screen.findByRole('list', { name: 'Paths' });
    expect(within(paths).getByText('/player')).toBeTruthy();
    expect(within(paths).getByText('Built in')).toBeTruthy();
    expect(within(paths).getAllByRole('link', { name: 'Open player' })).toHaveLength(2);

    // The portal's addresses arrive with the requests settings.
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/settings/requests')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    const addPath = screen.getByLabelText('Add path');
    fireEvent.change(addPath, { target: { value: '/requests-here' } });
    fireEvent.keyDown(addPath, { key: 'Enter' });
    expect(await screen.findByText('Already used by the request portal')).toBeTruthy();
    fireEvent.change(addPath, { target: { value: '/watch' } });
    fireEvent.keyDown(addPath, { key: 'Enter' });
    expect(within(paths).getByText('/watch')).toBeTruthy();
    fireEvent.click(within(paths).getByRole('button', { name: 'Remove /tv' }));

    const addHost = screen.getByLabelText('Add hostname');
    fireEvent.change(addHost, { target: { value: 'watch.example.com' } });
    fireEvent.keyDown(addHost, { key: 'Enter' });
    const hosts = await screen.findByRole('list', { name: 'Hostnames' });
    expect(within(hosts).getByRole('link', { name: 'Open player' }).getAttribute('href')).toBe('http://watch.example.com/');
    fireEvent.click(within(hosts).getByLabelText('Player only watch.example.com'));

    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
      address: { paths: ['/watch'], hosts: [{ hostname: 'watch.example.com', playerOnly: false }] },
    });
  });
});
