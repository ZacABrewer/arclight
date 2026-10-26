import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { MediaAnalysisQueueSummary } from '@arclight/shared';
import { renderAt, stubApi } from '../../test/route-harness.js';
import { analysisQueueText } from './tasks.js';

afterEach(() => vi.unstubAllGlobals());

const queue: MediaAnalysisQueueSummary = {
  ffprobePath: '/usr/bin/ffprobe',
  concurrency: 2,
  pending: 12,
  running: 2,
  done: 400,
  failed: 1,
  recentFailures: [{ mediaFileId: 9, path: '/media/tv/Show/S01E01.mkv', error: 'Invalid data found', finishedAt: '2026-10-26T01:00:00Z' }],
};

describe('analysis queue indicator', () => {
  it('words the counts', () => {
    expect(analysisQueueText(queue)).toBe('12 pending · 2 running · 1 failed');
    expect(analysisQueueText({ pending: 0, running: 0, failed: 0 })).toBe('Idle');
    expect(analysisQueueText({ pending: 3, running: 0, failed: 0 })).toBe('3 pending');
  });

  it('shows the queue on System → Tasks with the ffprobe path and last failure', async () => {
    stubApi({ '/api/v1/mediaanalysis/queue': queue, '/api/v1/jobs': [], '/api/v1/jobs/scheduled': [] });
    renderAt('/system/tasks');
    const line = await screen.findByRole('region', { name: 'Media analysis queue' });
    expect(within(line).getByRole('status').textContent).toContain('12 pending · 2 running · 1 failed');
    expect(within(line).getByText('/usr/bin/ffprobe · 2 at a time')).toBeTruthy();
    expect(within(line).getByText('/media/tv/Show/S01E01.mkv')).toBeTruthy();
  });

  it('warns with a fix link when ffprobe is missing', async () => {
    stubApi({ '/api/v1/mediaanalysis/queue': { ...queue, ffprobePath: null, recentFailures: [] }, '/api/v1/jobs': [], '/api/v1/jobs/scheduled': [] });
    renderAt('/system/tasks');
    const line = await screen.findByRole('region', { name: 'Media analysis queue' });
    expect(within(line).getByText(/ffprobe not found/)).toBeTruthy();
    expect(within(line).getByRole('link', { name: 'Fix' }).getAttribute('href')).toBe('/docs/system/health#ffprobe-missing');
  });
});
