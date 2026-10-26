import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CrossSeedResource, TranscodeJob } from '@arclight/shared';
import { renderAt, stubApi } from '../../test/route-harness.js';
import { canCancel, sizeChange } from './transcode-jobs-page.js';

configure({ asyncUtilTimeout: 5000 });

const seed = (over: Partial<CrossSeedResource>) =>
  CrossSeedResource.parse({
    id: 1,
    mediaFileId: 5,
    indexerId: 2,
    indexerName: 'TrackerB',
    infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
    title: 'Show.S01E01.1080p.WEB-DL-GRP',
    size: 1_500_000_000,
    state: 'seeding',
    message: null,
    downloadClientId: 7,
    savePath: '/downloads/cross-seed/abc',
    addedAt: '2026-10-25T10:00:00.000Z',
    ...over,
  });

const job = (over: Partial<TranscodeJob>) =>
  TranscodeJob.parse({
    id: 1,
    mediaFileId: 42,
    ruleId: 3,
    ruleName: 'HEVC to H.264',
    trigger: 'rule',
    status: 'running',
    progress: 37.5,
    path: '/tv/Show/Season 01/Show.S01E01.mkv',
    command: 'ffmpeg -i in.mkv out.mkv',
    message: null,
    queuedAt: '2026-10-25T10:00:00.000Z',
    startedAt: '2026-10-25T10:01:00.000Z',
    endedAt: null,
    sizeBefore: 4_000_000_000,
    sizeAfter: null,
    ...over,
  });

afterEach(() => vi.unstubAllGlobals());

describe('Activity -> Cross-seeds', () => {
  it('lists cross-seeds with state chips, mono info-hash and client names; the filter sends ?state', async () => {
    const api = stubApi({
      '/api/v1/crossseed': (_init: RequestInit | undefined, url: URL) =>
        url.searchParams.get('state') === 'failed'
          ? [seed({ id: 2, infoHash: 'f'.repeat(40), state: 'failed', title: 'Other.Release', message: 'piece hash mismatch', savePath: null })]
          : [seed({}), seed({ id: 2, infoHash: 'f'.repeat(40), state: 'failed', title: 'Other.Release', message: 'piece hash mismatch', savePath: null })],
      '/api/v1/downloadclient': [],
    });
    renderAt('/activity/crossseed');
    const table = await screen.findByRole('table', { name: 'Cross-seeds' });
    const hash = await within(table).findByText('abcdef0123456789abcdef0123456789abcdef01');
    expect(hash.closest('td')!.className).toContain('mono');
    expect(within(table).getByText('Seeding')).toBeTruthy();
    expect(within(table).getByText('piece hash mismatch')).toBeTruthy();
    expect(within(table).getByText('/downloads/cross-seed/abc')).toBeTruthy();
    expect(within(table).getAllByText('#7')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Cross-seeds' })).queryByText('Show.S01E01.1080p.WEB-DL-GRP')).toBeNull());
    expect(api.calls.some((c) => c.path === '/api/v1/crossseed' && c.method === 'GET')).toBe(true);
  });
});

describe('Activity -> Transcode jobs', () => {
  it('shows a live meter for running jobs and cancels queued/running ones', async () => {
    const api = stubApi({
      '/api/v1/transcode/jobs': [job({}), job({ id: 2, status: 'completed', progress: 100, sizeAfter: 2_000_000_000, trigger: 'manual', path: '/movies/Heat.mkv' })],
      'POST /api/v1/transcode/jobs/1/cancel': job({ status: 'cancelled' }),
    });
    renderAt('/activity/transcode');
    const table = await screen.findByRole('table', { name: 'Transcode jobs' });
    const meter = await within(table).findByRole('progressbar', { name: 'Progress of /tv/Show/Season 01/Show.S01E01.mkv' });
    expect(meter.className).toContain('al-meter--live');
    expect(within(table).getByText('38%')).toBeTruthy();
    expect(within(table).getByText('Manual')).toBeTruthy();
    const cancels = within(table).getAllByRole('button', { name: /^Cancel transcode of/ });
    expect(cancels).toHaveLength(1);
    fireEvent.click(cancels[0]!);
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/transcode/jobs/1/cancel')).toBe(true));
  });

  it('describes the size change and which jobs can be cancelled', () => {
    expect(canCancel({ status: 'queued' })).toBe(true);
    expect(canCancel({ status: 'failed' })).toBe(false);
    expect(sizeChange({ sizeBefore: null, sizeAfter: null })).toBe('—');
    expect(sizeChange({ sizeBefore: 4_000, sizeAfter: 1_000 })).toMatch(/\(-75%\)$/);
  });
});
