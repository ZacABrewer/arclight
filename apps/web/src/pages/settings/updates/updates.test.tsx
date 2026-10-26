import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ContainerUpdatesInfo, UpdateInfo, UpdateSettings } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { containerState, howToUpdate, windowLabel } from './update-model.js';

afterEach(() => vi.unstubAllGlobals());

const settings: UpdateSettings = {
  enabled: true,
  repo: 'arclight/arclight',
  channel: 'stable',
  checkIntervalHours: 24,
  notifyOnUpdate: true,
  mode: 'notify',
  autoUpdateWindow: { startHour: 3, endHour: 6 },
};

const info: UpdateInfo = {
  currentVersion: '0.2.0',
  latestVersion: '0.3.0',
  releaseNotes: '## Changes\n- Faster search',
  imageTag: 'v0.3.0',
  image: 'ghcr.io/arclight/arclight',
  checkedAt: '2026-10-26T10:00:00Z',
  updateAvailable: true,
  channel: 'stable',
  repo: 'arclight/arclight',
  enabled: true,
  isDocker: true,
  releases: [
    { version: '0.3.0', tag: 'v0.3.0', notes: '## Changes\n- Faster **search**\n- `docker compose` docs', prerelease: false, imageTag: 'v0.3.0', url: 'https://github.com/arclight/arclight/releases/tag/v0.3.0' },
  ],
};

const containers: ContainerUpdatesInfo = {
  dockerAvailable: true,
  socketPath: '/var/run/docker.sock',
  mode: 'notify',
  checkedAt: '2026-10-26T04:00:00Z',
  containers: [
    { id: 'g1', name: 'gluetun', image: 'qmcgaw/gluetun:latest', isSelf: false, currentDigest: 'sha256:aaaaaaaaaaaaaaaa', latestDigest: 'sha256:bbbbbbbbbbbbbbbb', updateAvailable: true },
    { id: 'a1', name: 'arclight', image: 'ghcr.io/arclight/arclight:latest', isSelf: true, networkParent: 'gluetun', currentDigest: 'sha256:cccccccccccc', updateAvailable: false },
  ],
};

describe('update model', () => {
  it('puts the running deployment first in the instructions', () => {
    const docker = howToUpdate(info);
    expect(docker.map((h) => h.id)).toEqual(['docker', 'native']);
    expect(docker[0]!.steps.map((s) => s.command).filter(Boolean)).toEqual([
      'docker compose pull arclight && docker compose up -d arclight',
      'ARCLIGHT_IMAGE=ghcr.io/arclight/arclight:v0.3.0',
    ]);
    const native = howToUpdate({ ...info, isDocker: false });
    expect(native[0]).toMatchObject({ id: 'native', current: true });
    expect(native[0]!.steps[0]!.command).toBe('https://github.com/arclight/arclight/releases/tag/v0.3.0');
  });

  it('labels windows and container states', () => {
    expect(windowLabel({ startHour: 3, endHour: 6 })).toBe('03:00–06:00');
    expect(windowLabel({ startHour: 4, endHour: 4 })).toBe('any time');
    expect(containerState(containers.containers[0]!)).toEqual({ label: 'Update available', tone: 'warn' });
    expect(containerState({ ...containers.containers[1]!, error: 'Built locally; there is no registry image to compare' }).tone).toBe('muted');
    expect(containerState({ ...containers.containers[1]!, error: 'ghcr.io is unreachable' })).toEqual({ label: 'Check failed', tone: 'danger' });
  });
});

describe('System → Updates', () => {
  it('shows running vs latest, a changelog pane per version and how to update', async () => {
    const api = stubApi({
      '/api/v1/system/update': info,
      'POST /api/v1/system/update/check': { ...info, checkedAt: '2026-10-26T11:00:00Z' },
      '/api/v1/settings/updates': settings,
      '/api/v1/system/update/containers': { ...containers, dockerAvailable: false, reason: 'Notify only: the Docker socket is not mounted at /var/run/docker.sock. Update by pulling the image.', containers: [] },
    });
    renderAt('/system/updates');
    expect(await screen.findByText('Arclight 0.3.0 is available')).toBeTruthy();
    const release = await screen.findByRole('region', { name: 'Release 0.3.0' });
    expect(within(release).getByText('search').tagName).toBe('STRONG');
    expect(within(release).getByText('docker compose').tagName).toBe('CODE');
    expect(screen.getByText('docker compose pull arclight && docker compose up -d arclight')).toBeTruthy();
    expect(await screen.findByText(/not mounted at \/var\/run\/docker\.sock/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/system/update/check')).toBe(true));
  });
});

describe('Settings → Updates', () => {
  it('lists labelled containers, updates one on demand and saves the mode', async () => {
    const api = stubApi({
      '/api/v1/settings/updates': settings,
      'PUT /api/v1/settings/updates': (init: RequestInit | undefined) => ({ ...settings, ...(JSON.parse(String(init?.body)) as object) }),
      '/api/v1/system/update/containers': containers,
      'POST /api/v1/system/update/containers/gluetun/update': { at: '2026-10-26T12:00:00Z', ok: true, updated: ['gluetun', 'arclight'], message: 'Updating gluetun, arclight; Arclight restarts in a few seconds.', handedOff: true },
    });
    renderAt('/settings/updates');
    const pane = await screen.findByRole('region', { name: 'Containers' });
    expect(await within(pane).findByText('gluetun')).toBeTruthy();
    expect(within(pane).getByText('aaaaaaaaaaaa → bbbbbbbbbbbb')).toBeTruthy();
    expect(within(pane).getByText('via gluetun')).toBeTruthy();
    expect(within(pane).getByText('This app')).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Update now' }));
    expect(await within(pane).findByText(/Arclight restarts in a few seconds/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Update automatically' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ mode: 'auto', autoUpdateWindow: { startHour: 3, endHour: 6 } }));
  });
});

describe('update health docs links', () => {
  it('links the update warning and the container label hint to the health docs', async () => {
    stubApi({
      '/api/v1/system/update': info,
      '/api/v1/settings/updates': settings,
      '/api/v1/system/update/containers': containers,
    });
    renderAt('/system/updates');
    expect((await screen.findByRole('link', { name: 'About this warning' })).getAttribute('href')).toBe('/docs/system/health#update-available');
    const pane = await screen.findByRole('region', { name: 'Containers' });
    expect(await within(pane).findByText('arclight.autoupdate=true')).toBeTruthy();
    expect(within(pane).getByRole('link', { name: 'About container updates' }).getAttribute('href')).toBe('/docs/system/health#container-updates-available');
  });

  it('updates every container with Update all', async () => {
    const api = stubApi({
      '/api/v1/settings/updates': settings,
      '/api/v1/system/update/containers': containers,
      'POST /api/v1/system/update/containers/update': { at: '2026-10-26T12:00:00Z', ok: true, updated: ['gluetun'], message: 'Updated gluetun.', handedOff: false },
    });
    renderAt('/settings/updates');
    const pane = await screen.findByRole('region', { name: 'Containers' });
    fireEvent.click(await within(pane).findByRole('button', { name: 'Update all' }));
    expect(await within(pane).findByText(/Updated gluetun\./)).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/system/update/containers/update')).toBe(true);
  });
});
