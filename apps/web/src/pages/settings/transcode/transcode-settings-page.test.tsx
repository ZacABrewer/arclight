import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { TranscodeHwaccelResponse, TranscodeRule, TranscodeRuleInput } from '@arclight/shared';
import { renderAt, stubApi, type FakeApi } from '../../../test/route-harness.js';
import { brokenRuleBackends } from './hardware-pane.js';
import { hwaccelOptions } from './transcode-settings-page.js';

configure({ asyncUtilTimeout: 5000 });

const rule = TranscodeRule.parse({
  id: 3,
  name: 'Remux MP4',
  enabled: true,
  mediaType: 'series',
  scope: { kind: 'all' },
  when: { container: 'mp4' },
  action: 'remux',
  options: { container: 'mkv', videoCodec: 'copy', audio: 'copy', keepLanguages: [], dropSubtitles: false, hwaccel: 'none' },
  keepOriginal: false,
  runAfterImport: true,
  schedule: { start: '22:00', end: '06:00' },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

const QSV_REASON = 'No supported child device type is enabled';
const hw = TranscodeHwaccelResponse.parse({
  ffmpegPath: '/usr/bin/ffmpeg',
  methods: ['vaapi', 'qsv', 'cuda'],
  backends: ['none', 'vaapi', 'nvenc'],
  results: [
    { backend: 'none', available: true, reason: null },
    { backend: 'vaapi', available: true, reason: null },
    { backend: 'qsv', available: false, reason: QSV_REASON },
    { backend: 'nvenc', available: true, reason: null },
    { backend: 'videotoolbox', available: false, reason: 'this ffmpeg build has no VideoToolbox support' },
  ],
  testedAt: '2026-10-30T12:00:00.000Z',
});
const qsvRule = TranscodeRule.parse({
  ...rule,
  id: 5,
  name: 'To HEVC (QSV)',
  action: 'transcode',
  options: { ...rule.options, videoCodec: 'hevc', hwaccel: 'qsv' },
});
let api: FakeApi;

beforeEach(() => {
  api = stubApi({
    '/api/v1/transcoderule': [rule],
    'POST /api/v1/transcoderule': (init: RequestInit | undefined) =>
      new Response(JSON.stringify({ ...rule, ...TranscodeRuleInput.parse(JSON.parse(String(init?.body))), id: 4 }), { status: 201 }),
    '/api/v1/transcode/hwaccel': hw,
    '/api/v1/settings/transcode': { fallbackToSoftware: true },
    'PUT /api/v1/settings/transcode': (init: RequestInit | undefined) => new Response(String(init?.body), { status: 200 }),
    'POST /api/v1/transcode/run': { queued: 3, jobs: [] },
    '/api/v1/qualityprofile': [],
    '/api/v1/tag': [],
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Settings -> Transcode rules', () => {
  it('disables hwaccel backends that failed their test, unless the rule already uses one', () => {
    const opts = hwaccelOptions(hw.results, 'qsv');
    expect(opts.find((o) => o.value === 'vaapi')).toMatchObject({ disabled: false, label: 'VAAPI' });
    expect(opts.find((o) => o.value === 'videotoolbox')).toMatchObject({ disabled: true, label: 'VideoToolbox (failed its test)' });
    expect(opts.find((o) => o.value === 'qsv')).toMatchObject({ disabled: false, label: 'Intel Quick Sync (QSV) (failed its test)' });
    expect(opts.find((o) => o.value === 'none')?.disabled).toBe(false);
    expect(hwaccelOptions(hw.results, 'none').find((o) => o.value === 'qsv')?.disabled).toBe(true);
  });

  it('brokenRuleBackends lists enabled encoding rules on a backend that failed', () => {
    const disabled = TranscodeRule.parse({ ...qsvRule, id: 6, name: 'Off', enabled: false });
    expect(brokenRuleBackends([rule, qsvRule, disabled], hw.results)).toEqual([{ backend: 'qsv', reason: QSV_REASON, rules: ['To HEVC (QSV)'] }]);
    expect(brokenRuleBackends([rule], hw.results)).toEqual([]);
    expect(brokenRuleBackends(undefined, hw.results)).toEqual([]);
  });

  it('shows each backend test, warns about rules on a broken backend and re-tests on Test again', async () => {
    let refreshed = 0;
    api = stubApi({
      '/api/v1/transcoderule': [rule, qsvRule],
      '/api/v1/transcode/hwaccel': (_init: RequestInit | undefined, url: URL) => {
        if (url.searchParams.get('refresh') === 'true') refreshed++;
        return hw;
      },
      '/api/v1/settings/transcode': { fallbackToSoftware: true },
      'PUT /api/v1/settings/transcode': (init: RequestInit | undefined) => new Response(String(init?.body), { status: 200 }),
      '/api/v1/qualityprofile': [],
      '/api/v1/tag': [],
    });
    renderAt('/settings/transcode');
    const pane = await screen.findByRole('region', { name: 'Hardware acceleration' });
    const table = await within(pane).findByRole('table', { name: 'Hardware acceleration' });
    const qsvRow = within(table).getByText('Intel Quick Sync (QSV)').closest('tr')!;
    expect(within(qsvRow).getByText('Unavailable')).toBeTruthy();
    expect(within(qsvRow).getByText(QSV_REASON)).toBeTruthy();
    const vaapiRow = within(table).getByText('VAAPI').closest('tr')!;
    expect(within(vaapiRow).getByText('Works')).toBeTruthy();
    expect(await within(pane).findByText(/Intel Quick Sync \(QSV\) failed its test, but To HEVC \(QSV\) use it/)).toBeTruthy();
    expect(within(pane).getByText(/Those jobs retry in software/)).toBeTruthy();

    fireEvent.click(within(pane).getByRole('button', { name: 'Test again' }));
    await waitFor(() => expect(refreshed).toBe(1));

    const toggle = within(pane).getByLabelText('Fall back to software') as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    fireEvent.click(toggle);
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/settings/transcode')?.body).toEqual({ fallbackToSoftware: false }));
  });

  it('warns in the rule editor when the chosen backend failed its test', async () => {
    api = stubApi({
      '/api/v1/transcoderule': [qsvRule],
      '/api/v1/transcode/hwaccel': hw,
      '/api/v1/settings/transcode': { fallbackToSoftware: true },
      '/api/v1/qualityprofile': [],
      '/api/v1/tag': [],
    });
    renderAt('/settings/transcode');
    const table = await screen.findByRole('table', { name: 'Transcode rules' });
    fireEvent.click(await within(table).findByRole('button', { name: 'Edit To HEVC (QSV)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit To HEVC (QSV)' });
    expect(await within(dialog).findByText(`Intel Quick Sync (QSV) failed its hardware test: ${QSV_REASON}`)).toBeTruthy();
  });

  it('lists rules with their conditions and window, and Run posts {ruleId}', async () => {
    renderAt('/settings/transcode');
    const table = await screen.findByRole('table', { name: 'Transcode rules' });
    expect(await within(table).findByText('Remux MP4')).toBeTruthy();
    expect(within(table).getByText('mp4')).toBeTruthy();
    expect(within(table).getByText('22:00–06:00')).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: 'Run Remux MP4 on the library' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/transcode/run')?.body).toEqual({ ruleId: 3 }));
    expect(await screen.findByText('Queued 3 jobs')).toBeTruthy();
  });

  it('creates a transcode rule with the options the action uses and the hwaccel from ffmpeg', async () => {
    renderAt('/settings/transcode');
    fireEvent.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add rule' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '4K to HEVC' } });
    fireEvent.change(within(dialog).getByLabelText('Height above'), { target: { value: '1080' } });
    // Remux shows no encoder settings.
    expect(within(dialog).queryByLabelText('Hardware encoding')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Action'), { target: { value: 'transcode' } });
    fireEvent.change(within(dialog).getByLabelText('Video'), { target: { value: 'hevc' } });
    const hwSelect = (await within(dialog).findByLabelText('Hardware encoding')) as HTMLSelectElement;
    await waitFor(() => expect([...hwSelect.options].find((o) => o.value === 'vaapi')?.disabled).toBe(false));
    expect([...hwSelect.options].find((o) => o.value === 'qsv')?.disabled).toBe(true);
    expect([...hwSelect.options].find((o) => o.value === 'nvenc')?.disabled).toBe(false);
    fireEvent.change(hwSelect, { target: { value: 'vaapi' } });
    fireEvent.change(within(dialog).getByLabelText('Quality (CRF)'), { target: { value: '24' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/transcoderule')).toBe(true));
    const body = api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/transcoderule')!.body;
    expect(body).toMatchObject({
      name: '4K to HEVC',
      action: 'transcode',
      when: { resolutionAbove: 1080 },
      options: { container: 'mkv', videoCodec: 'hevc', hwaccel: 'vaapi', crf: 24, audio: 'copy' },
      schedule: null,
    });
    expect(TranscodeRuleInput.safeParse(body).success).toBe(true);
  });
});
