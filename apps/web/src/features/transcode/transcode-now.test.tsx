import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { TranscodeRule, TranscodeRunRequest, TranscodeRunResult } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { stubApi, type FakeApi } from '../../test/route-harness.js';
import { TranscodeNowButton, ruleOptions, transcodeRunBody } from './transcode-now.js';

configure({ asyncUtilTimeout: 4000 });

const makeRule = (id: number, name: string, enabled = true) =>
  TranscodeRule.parse({
    id,
    name,
    enabled,
    mediaType: 'all',
    scope: { kind: 'all' },
    when: {},
    action: 'remux',
    options: { container: 'mkv', videoCodec: 'copy', audio: 'copy', keepLanguages: [], dropSubtitles: false, hwaccel: 'none' },
    keepOriginal: false,
    runAfterImport: false,
    schedule: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });

const runResult = TranscodeRunResult.parse({ queued: 1, jobs: [] });
let api: FakeApi;

beforeEach(() => {
  api = stubApi({
    '/api/v1/transcoderule': [makeRule(1, 'Remux to MKV'), makeRule(2, 'Old rule', false), makeRule(3, 'Strip')],
    'POST /api/v1/transcode/run': runResult,
  });
});
afterEach(() => vi.unstubAllGlobals());

function renderButton() {
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <TranscodeNowButton mediaFileId={42} fileLabel="Season 01/Show.S01E01.mkv" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('transcode now', () => {
  it('builds a run body with exactly one of mediaFileId or ruleId', () => {
    expect(transcodeRunBody(42, '')).toEqual({ mediaFileId: 42 });
    expect(transcodeRunBody(42, '3')).toEqual({ ruleId: 3 });
    expect(TranscodeRunRequest.safeParse(transcodeRunBody(42, '')).success).toBe(true);
    expect(ruleOptions([makeRule(1, 'A'), makeRule(2, 'B', false)]).map((o) => o.value)).toEqual(['', '1']);
  });

  it('queues the file for the first matching rule by default', async () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Transcode Season 01/Show.S01E01.mkv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Transcode now' });
    const select = within(dialog).getByLabelText('Rule') as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(3));
    expect([...select.options].map((o) => o.text)).toEqual(['First matching rule', 'Remux to MKV', 'Strip']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transcode' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ mediaFileId: 42 }));
    expect(await screen.findByText('Queued 1 job')).toBeTruthy();
  });

  it('runs a chosen rule by id and warns that it covers the library', async () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Transcode Season 01/Show.S01E01.mkv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Transcode now' });
    const select = within(dialog).getByLabelText('Rule') as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(3));
    fireEvent.change(select, { target: { value: '3' } });
    expect(within(dialog).getByText(/every matching file in the library/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run rule' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ ruleId: 3 }));
  });
});
