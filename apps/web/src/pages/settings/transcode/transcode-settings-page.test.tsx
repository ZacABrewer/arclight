import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { TranscodeHwaccelResponse, TranscodeRule, TranscodeRuleInput } from '@arclight/shared';
import { renderAt, stubApi, type FakeApi } from '../../../test/route-harness.js';
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

const hw = TranscodeHwaccelResponse.parse({ ffmpegPath: '/usr/bin/ffmpeg', methods: ['vaapi', 'cuda'], backends: ['vaapi', 'nvenc'] });
let api: FakeApi;

beforeEach(() => {
  api = stubApi({
    '/api/v1/transcoderule': [rule],
    'POST /api/v1/transcoderule': (init: RequestInit | undefined) =>
      new Response(JSON.stringify({ ...rule, ...TranscodeRuleInput.parse(JSON.parse(String(init?.body))), id: 4 }), { status: 201 }),
    '/api/v1/transcode/hwaccel': hw,
    'POST /api/v1/transcode/run': { queued: 3, jobs: [] },
    '/api/v1/qualityprofile': [],
    '/api/v1/tag': [],
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Settings -> Transcode rules', () => {
  it('disables hwaccel backends ffmpeg does not report, unless the rule already uses one', () => {
    const opts = hwaccelOptions(hw.backends, 'qsv');
    expect(opts.find((o) => o.value === 'vaapi')).toMatchObject({ disabled: false, label: 'VAAPI' });
    expect(opts.find((o) => o.value === 'videotoolbox')).toMatchObject({ disabled: true, label: 'VideoToolbox (not reported by ffmpeg)' });
    expect(opts.find((o) => o.value === 'qsv')?.disabled).toBe(false);
    expect(opts.find((o) => o.value === 'none')?.disabled).toBe(false);
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
