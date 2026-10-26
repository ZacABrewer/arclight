import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SubtitleSettings, SubtitleWhisperStatus, type SubtitleProviderSchema, type SubtitleProvidersResponse } from '@arclight/shared';
import { languageProfiles, languages, mockApi, renderAt, type Call } from '../../subtitles/test-harness.js';
import { hasFallbackToggle, onlyWhenNoOtherResult } from './providers-card.js';
import { whisperState } from './whisper-status-card.js';

afterEach(() => vi.unstubAllGlobals());

const whisperSchema: SubtitleProviderSchema = {
  id: 'whisperai',
  name: 'Whisper (ASR)',
  description: 'Generates subtitles from the audio.',
  mediaTypes: ['series', 'movie'],
  needsAuth: false,
  fields: [
    { name: 'endpoint', label: 'Endpoint', type: 'text', required: true, secret: false, default: 'http://127.0.0.1:9000' },
    { name: 'onlyWhenNoOtherResult', label: 'Only when no other result', type: 'checkbox', required: false, secret: false, default: true },
  ],
};
const podnapisi: SubtitleProviderSchema = { id: 'podnapisi', name: 'Podnapisi', description: 'Slovenian site', mediaTypes: ['series', 'movie'], needsAuth: false, fields: [] };

const settings = SubtitleSettings.parse({
  providers: [{ id: 'whisperai', enabled: true, settings: { endpoint: 'http://whisper:9000' } }],
});

const providers: SubtitleProvidersResponse = {
  schema: [whisperSchema, podnapisi],
  status: [
    { id: 'whisperai', name: 'Whisper (ASR)', enabled: true, configured: true, configError: null, throttle: null },
    { id: 'podnapisi', name: 'Podnapisi', enabled: false, configured: true, configError: null, throttle: null },
  ],
};

const status = SubtitleWhisperStatus.parse({
  envUrl: 'http://whisper:9000',
  endpoint: 'http://whisper:9000',
  registered: true,
  enabled: true,
  autoRegistered: true,
  onlyWhenNoOtherResult: true,
  reachable: false,
  message: 'Connection refused',
  checkedAt: '2026-10-26T08:00:00.000Z',
});

const routes = {
  'GET /health': { status: 'ok', checks: [] },
  'GET /subtitle/languages': languages,
  'GET /languageprofile': languageProfiles,
  'GET /subtitle/settings': settings,
  'GET /subtitle/providers': providers,
  'GET /subtitle/whisper/status': status,
  'PUT /subtitle/settings': (c: Call) => c.body,
};

describe('whisper helpers', () => {
  it('derives the card state from the status record', () => {
    expect(whisperState(status)).toBe('unreachable');
    expect(whisperState({ ...status, reachable: true })).toBe('reachable');
    expect(whisperState({ ...status, reachable: null })).toBe('unknown');
    expect(whisperState({ ...status, enabled: false })).toBe('disabled');
    expect(whisperState({ ...status, registered: false })).toBe('unregistered');
    expect(whisperState({ ...status, registered: false, envUrl: null })).toBe('unconfigured');
  });

  it('reads the fallback flag from settings, else the field default', () => {
    expect(hasFallbackToggle(whisperSchema)).toBe(true);
    expect(hasFallbackToggle(podnapisi)).toBe(false);
    expect(onlyWhenNoOtherResult({ id: 'whisperai', enabled: true, settings: {} }, whisperSchema)).toBe(true);
    expect(onlyWhenNoOtherResult({ id: 'whisperai', enabled: true, settings: { onlyWhenNoOtherResult: false } }, whisperSchema)).toBe(false);
    // Whisper without the field in its schema still defaults to on.
    expect(onlyWhenNoOtherResult({ id: 'whisperai', enabled: true, settings: {} }, { ...whisperSchema, fields: [] })).toBe(true);
  });
});

describe('subtitle settings: sync check and whisper', () => {
  it('edits every sync-check field and saves them', async () => {
    const calls = mockApi(routes);
    renderAt('/settings/subtitles');
    const section = await screen.findByRole('region', { name: 'Sync check' });
    fireEvent.click(within(section).getByLabelText(/Check sync of downloads/));
    fireEvent.change(within(section).getByLabelText(/Check method/), { target: { value: 'tool' } });
    fireEvent.change(within(section).getByLabelText(/Audio analysed/), { target: { value: '15' } });
    fireEvent.change(within(section).getByLabelText(/Sync when score is below/), { target: { value: '60' } });
    fireEvent.change(within(section).getByLabelText(/Try another subtitle below/), { target: { value: '40' } });
    fireEvent.change(within(section).getByLabelText(/Candidates tried per language/), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const body = SubtitleSettings.parse(calls.find((c) => c.method === 'PUT')!.body);
    expect(body.sync).toMatchObject({
      autoCheck: true,
      checkMethod: 'tool',
      checkWindowMinutes: 15,
      autoFixBelow: 60,
      autoRetryProviderBelow: 40,
      maxProviderRetries: 3,
      // Untouched fields keep their values.
      audioDetector: 'silencedetect',
      checkBatchSize: 20,
      tool: 'ffsubsync',
    });
  });

  it('shows advanced sync-check fields only with Show advanced', async () => {
    mockApi(routes);
    renderAt('/settings/subtitles');
    const section = await screen.findByRole('region', { name: 'Sync check' });
    expect(within(section).queryByLabelText(/Audio detector/)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /advanced/i }));
    expect(await within(section).findByLabelText(/Audio detector/)).toBeTruthy();
    expect(within(section).getByLabelText(/Subtitles checked per run/)).toBeTruthy();
  });

  it('shows the whisper status card with the probe result and re-checks', async () => {
    const calls = mockApi(routes);
    renderAt('/settings/subtitles');
    const card = await screen.findByTestId('whisper-status');
    expect(within(card).getByText('Unreachable').closest('[data-tone]')?.getAttribute('data-tone')).toBe('danger');
    expect(within(card).getByText('Connection refused')).toBeTruthy();
    expect(within(card).getByText('Added automatically')).toBeTruthy();
    expect(within(card).getAllByText('http://whisper:9000')).toHaveLength(2);
    const before = calls.filter((c) => c.path === '/subtitle/whisper/status').length;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/subtitle/whisper/status').length).toBeGreaterThan(before));
  });

  it('leaves the whisper card out when the status route is missing', async () => {
    const { 'GET /subtitle/whisper/status': _omit, ...rest } = routes;
    const calls = mockApi(rest);
    renderAt('/settings/subtitles');
    await screen.findByRole('region', { name: 'Sync check' });
    await waitFor(() => expect(calls.some((c) => c.path === '/subtitle/whisper/status')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Whisper (speech to text)' })).toBeNull());
    expect(screen.queryByTestId('whisper-status')).toBeNull();
  });

  it('turns off "Only when no other result" on the Whisper card and saves it in the provider settings', async () => {
    const calls = mockApi(routes);
    renderAt('/settings/subtitles');
    const card = await screen.findByRole('region', { name: 'Whisper (ASR)' });
    const toggle = within(card).getByRole('switch', { name: 'Only when no other result for Whisper (ASR)' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    // Rendered once, as the toggle, not again as a schema checkbox.
    expect(within(card).getAllByLabelText(/Only when no other result/)).toHaveLength(1);
    expect(within(screen.getByRole('region', { name: 'Podnapisi' })).queryByRole('switch', { name: /Only when no other result/ })).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const body = calls.find((c) => c.method === 'PUT')!.body as SubtitleSettings;
    expect(body.providers[0]).toEqual({ id: 'whisperai', enabled: true, settings: { endpoint: 'http://whisper:9000', onlyWhenNoOtherResult: false } });
  });
});
