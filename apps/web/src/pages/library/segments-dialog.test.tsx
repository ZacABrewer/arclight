import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { EpisodeSegmentsRow, SeasonSegmentsResponse } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { stubApi, type FakeApi } from '../../test/route-harness.js';
import { formatClock, parseClock, rowSegments, SegmentsDialog, toRowDraft } from './segments-dialog.js';

configure({ asyncUtilTimeout: 5000 });
afterEach(() => vi.unstubAllGlobals());

const row = (over: Partial<EpisodeSegmentsRow>): EpisodeSegmentsRow => ({
  episodeId: 1,
  mediaFileId: 11,
  seasonNumber: 2,
  episodeNumber: 1,
  title: 'Pilot',
  durationMs: 2_700_000,
  segments: [],
  manual: false,
  ...over,
});

describe('m:ss', () => {
  it('formats and parses clock times', () => {
    expect(formatClock(83_000)).toBe('1:23');
    expect(formatClock(3_723_400)).toBe('1:02:03');
    expect(formatClock(0)).toBe('0:00');
    expect(parseClock('1:23')).toBe(83_000);
    expect(parseClock(' 1:02:03 ')).toBe(3_723_000);
    expect(parseClock('95')).toBe(95_000);
    expect(parseClock('1:23.5')).toBe(83_500);
    expect(parseClock('')).toBeNull();
    expect(parseClock('1:75')).toBeNaN();
    expect(parseClock('abc')).toBeNaN();
  });

  it('turns a draft into manual segments and keeps recaps', () => {
    const r = row({
      segments: [
        { type: 'recap', startMs: 0, endMs: 30_000, source: 'chapter' },
        { type: 'intro', startMs: 30_000, endMs: 75_000, source: 'fingerprint' },
      ],
    });
    const d = toRowDraft(r);
    expect(d).toEqual({ intro: { start: '0:30', end: '1:15' }, credits: { start: '', end: '' } });
    expect(rowSegments({ ...d, credits: { start: '42:00', end: '50:00' } }, r)).toEqual({
      ok: true,
      segments: [
        { type: 'intro', startMs: 30_000, endMs: 75_000 },
        { type: 'credits', startMs: 2_520_000, endMs: 2_700_000 },
        { type: 'recap', startMs: 0, endMs: 30_000 },
      ],
    });
    expect(rowSegments({ ...d, intro: { start: '1:15', end: '0:30' } }, r)).toEqual({ ok: false, error: 'Intro: the end must be after the start.' });
    expect(rowSegments({ ...d, intro: { start: '0:30', end: '' } }, r)).toEqual({ ok: false, error: 'Intro: enter both times as m:ss.' });
    expect(rowSegments({ ...d, credits: { start: '46:00', end: '47:00' } }, r)).toEqual({ ok: false, error: 'Credits: starts after the end of the file.' });
    expect(rowSegments({ intro: { start: '', end: '' }, credits: { start: '', end: '' } }, row({}))).toEqual({ ok: true, segments: [] });
  });
});

describe('SegmentsDialog', () => {
  let api: FakeApi;
  const season = (episodes: EpisodeSegmentsRow[]): SeasonSegmentsResponse => ({ seriesId: 5, seasonNumber: 2, scan: { status: 'done', scannedAt: '2026-05-01T03:40:00.000Z', error: null }, episodes });

  function mount() {
    const toasts = createToastStore();
    render(
      <QueryClientProvider client={createQueryClient(toasts)}>
        <ToastProvider store={toasts}>
          <SegmentsDialog open onClose={() => {}} seriesId={5} seasonNumber={2} title="Show Season 2" />
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('edits an episode, resets a manual one and scans the season', async () => {
    api = stubApi({
      '/api/v1/playback/segments/series/5/season/2': season([
        row({ segments: [{ type: 'intro', startMs: 30_000, endMs: 75_000, source: 'fingerprint' }] }),
        row({ episodeId: 2, mediaFileId: 12, episodeNumber: 2, title: 'Second', manual: true, segments: [{ type: 'credits', startMs: 2_500_000, endMs: 2_700_000, source: 'manual' }] }),
      ]),
      'PUT /api/v1/playback/segments/file/11': () => null,
      'DELETE /api/v1/playback/segments/file/12': () => null,
      'POST /api/v1/playback/segments/scan': { queued: 1 },
    });
    mount();
    const first = await screen.findByRole('listitem', { name: 'S02E01 Pilot' });
    expect(within(first).getByText('Detected')).toBeTruthy();
    const end = within(first).getByLabelText('Intro end, S02E01') as HTMLInputElement;
    expect(end.value).toBe('1:15');
    const save = within(first).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(end, { target: { value: '1:20' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')).toMatchObject({ path: '/api/v1/playback/segments/file/11', body: { segments: [{ type: 'intro', startMs: 30_000, endMs: 80_000 }] } });

    const second = screen.getByRole('listitem', { name: 'S02E02 Second' });
    expect(within(first).queryByRole('button', { name: 'Reset to detected' })).toBeNull();
    fireEvent.click(within(second).getByRole('button', { name: 'Reset to detected' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/playback/segments/file/12')).toBe(true));

    // A bad time explains itself and cannot be saved.
    fireEvent.change(within(first).getByLabelText('Intro start, S02E01'), { target: { value: '9:99' } });
    expect(within(first).getByRole('alert').textContent).toBe('Intro: enter both times as m:ss.');

    fireEvent.click(screen.getByRole('button', { name: 'Scan this season' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ seriesId: 5, seasonNumber: 2 });
    expect(screen.getByTestId('segments-scan').textContent).toMatch(/^Last scanned /);
  });
});
