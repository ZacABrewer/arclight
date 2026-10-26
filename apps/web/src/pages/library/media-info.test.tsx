import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { MediaFile } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { analyzeToast } from '../../hooks/media-analysis.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { stubApi } from '../../test/route-harness.js';
import { MediaFilesTable } from './media-files-table.js';
import { channelLabel, dynamicRangeLabel, mediaBadges, mediaInfoSummary, resolutionLabel } from './media-info.js';

afterEach(() => vi.unstubAllGlobals());

const quality = {
  quality: { id: 9, name: 'WEBDL-2160p', source: 'web', resolution: 2160, modifier: 'none', weight: 20, mediaTypes: ['series', 'movie'] },
  revision: { version: 1, real: 0, isRepack: false },
} as MediaFile['quality'];

function file(id: number, mediaInfo: MediaFile['mediaInfo']): MediaFile {
  return {
    id,
    mediaType: 'movie',
    movieId: 7,
    episodeIds: [],
    relativePath: `Dune (2021) - ${id}.mkv`,
    path: `/movies/Dune (2021)/Dune (2021) - ${id}.mkv`,
    sizeBytes: 40 * 1024 ** 3,
    dateAdded: '2026-10-01T00:00:00.000Z',
    quality,
    languages: ['English'],
    mediaInfo,
  };
}

describe('media info badges', () => {
  it('formats channel counts', () => {
    expect(channelLabel(6)).toBe('5.1');
    expect(channelLabel(8)).toBe('7.1');
    expect(channelLabel(2)).toBe('2.0');
    expect(channelLabel(0)).toBeNull();
    expect(channelLabel(null)).toBeNull();
  });

  it('derives the resolution from the frame or the resolution string', () => {
    expect(resolutionLabel({ width: 3840, height: 1600 })).toBe('2160p');
    expect(resolutionLabel({ resolution: '1920x800' })).toBe('1080p');
    expect(resolutionLabel({ width: 1280, height: 720 })).toBe('720p');
    expect(resolutionLabel({ height: 480, width: 720 })).toBe('480p');
    expect(resolutionLabel({})).toBeNull();
  });

  it('shows HDR only, with the Dolby Vision profile', () => {
    expect(dynamicRangeLabel({ videoDynamicRange: 'SDR' })).toBeNull();
    expect(dynamicRangeLabel({ videoDynamicRangeType: 'HDR10Plus' })).toBe('HDR10+');
    expect(dynamicRangeLabel({ videoDynamicRangeType: 'DV HDR10', doviProfile: 8 })).toBe('DV P8 HDR10');
    expect(dynamicRangeLabel({ videoDynamicRange: 'HLG' })).toBe('HLG');
  });

  it('builds the badge list in reading order', () => {
    const badges = mediaBadges({ videoCodec: 'x265', width: 3840, height: 2160, videoDynamicRangeType: 'HDR10', videoBitDepth: 10, audioCodec: 'TrueHD Atmos', audioChannels: 8, audioStreamCount: 3 });
    expect(badges.map((b) => b.label)).toEqual(['x265', '2160p', 'HDR10', '10-bit', 'TrueHD Atmos 7.1', '+2 audio']);
    expect(mediaBadges(null)).toEqual([]);
    expect(mediaBadges({ videoFormat: 'h264', audioFormat: 'aac', audioChannels: 2 }).map((b) => b.label)).toEqual(['H264', 'AAC 2.0']);
  });

  it('summarises languages and subtitles for the tooltip', () => {
    expect(mediaInfoSummary(undefined)).toBe('Not analyzed yet');
    expect(mediaInfoSummary({ videoCodec: 'AVC', audioLanguages: ['eng', 'jpn'], subtitles: ['eng'] })).toBe('AVC · audio eng, jpn · subs eng');
    expect(mediaInfoSummary({})).toBe('No streams found');
  });

  it('words the analyze toast', () => {
    expect(analyzeToast({ queued: 3, ffprobeAvailable: true }).title).toBe('Analyzing 3 files');
    expect(analyzeToast({ queued: 1, ffprobeAvailable: true }).title).toBe('Analyzing 1 file');
    expect(analyzeToast({ queued: 0, ffprobeAvailable: true }).title).toBe('Nothing to analyze');
    expect(analyzeToast({ queued: 2, ffprobeAvailable: false })).toMatchObject({ tone: 'warning', title: 'ffprobe not found' });
  });
});

describe('Files tab', () => {
  function renderTable(files: MediaFile[]) {
    const toasts = createToastStore();
    render(
      <QueryClientProvider client={createQueryClient(toasts)}>
        <ToastProvider store={toasts}>
          <MediaFilesTable files={files} error={null} loading={false} mediaType="movie" ownerId={7} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    return toasts;
  }

  it('renders badges per file and "Not analyzed" without media info', () => {
    stubApi({});
    renderTable([file(1, { videoCodec: 'x265', height: 2160, width: 3840, videoDynamicRangeType: 'DV HDR10', doviProfile: 7, audioCodec: 'DTS-HD MA', audioChannels: 6 }), file(2, null)]);
    const table = screen.getByRole('table', { name: 'Media files' });
    const first = within(table).getByText('Dune (2021) - 1.mkv').closest('tr') as HTMLElement;
    for (const label of ['x265', '2160p', 'DV P7 HDR10', 'DTS-HD MA 5.1']) expect(within(first).getByText(label)).toBeTruthy();
    const second = within(table).getByText('Dune (2021) - 2.mkv').closest('tr') as HTMLElement;
    expect(within(second).getByText('Not analyzed')).toBeTruthy();
  });

  it('Analyze posts the movie id and toasts the queued count', async () => {
    const api = stubApi({ 'POST /api/v1/command/analyze': { queued: 2, ffprobeAvailable: true } });
    const toasts = renderTable([file(1, null)]);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/command/analyze')?.body).toEqual({ movieId: 7 }));
    await waitFor(() => expect(toasts.list().some((t) => t.title === 'Analyzing 2 files')).toBe(true));
  });

  it('warns when ffprobe is missing', async () => {
    stubApi({ 'POST /api/v1/command/analyze': { queued: 1, ffprobeAvailable: false } });
    const toasts = renderTable([file(1, null)]);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(toasts.list().find((t) => t.title === 'ffprobe not found')?.tone).toBe('warning'));
  });

  it('disables Analyze when there are no files', () => {
    stubApi({});
    renderTable([]);
    expect((screen.getByRole('button', { name: 'Analyze' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
