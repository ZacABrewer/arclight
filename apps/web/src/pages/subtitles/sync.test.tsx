import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SubtitleHistoryRecord, SubtitleSyncCheckResult, SubtitleState, type MediaFileSubtitles } from '@arclight/shared';
import { makeMovie } from '../library/test-fixtures.js';
import { formatSyncDrift, formatSyncOffset, syncGrade, syncShiftText, syncTone } from './sync-ui.js';
import { languageProfiles, languages, makeSubtitle, mockApi, movieFile, renderAt, type Call } from './test-harness.js';

afterEach(() => vi.unstubAllGlobals());

const base = {
  'GET /health': { status: 'ok', checks: [] },
  'GET /subtitle/languages': languages,
  'GET /languageprofile': languageProfiles,
  'GET /tag': [],
  'GET /qualityprofile': [],
  'GET /mediafile': [],
};

describe('sync helpers', () => {
  it('grades scores into tones', () => {
    expect(syncGrade(95)).toBe('good');
    expect(syncGrade(80)).toBe('good');
    expect(syncGrade(79)).toBe('fair');
    expect(syncGrade(50)).toBe('fair');
    expect(syncGrade(49)).toBe('poor');
    expect(syncGrade(null)).toBe('unknown');
    expect(syncGrade(undefined)).toBe('unknown');
    expect([syncTone(90), syncTone(60), syncTone(10), syncTone(null)]).toEqual(['accent', 'warn', 'danger', 'muted']);
  });

  it('formats offsets in ms below a second and seconds above', () => {
    expect(formatSyncOffset(320)).toBe('+320 ms');
    expect(formatSyncOffset(-45)).toBe('-45 ms');
    expect(formatSyncOffset(0)).toBe('0 ms');
    expect(formatSyncOffset(1250)).toBe('+1.25 s');
    expect(formatSyncOffset(-2000)).toBe('-2 s');
    expect(formatSyncOffset(null)).toBe('—');
  });

  it('formats drift in ppm and joins offset and drift', () => {
    expect(formatSyncDrift(42700)).toBe('+42700 ppm');
    expect(formatSyncDrift(-12)).toBe('-12 ppm');
    expect(formatSyncDrift(undefined)).toBe('—');
    expect(syncShiftText({ syncOffsetMs: 320, syncDriftPpm: 0 })).toBe('+320 ms · 0 ppm');
    expect(syncShiftText({})).toBe('—');
  });
});

describe('sync badge in the movie subtitles tab', () => {
  const movie = makeMovie({ id: 1, title: 'Dune', hasFile: true, languageProfileId: 1 });
  const checked = SubtitleState.parse(
    makeSubtitle({
      id: 11,
      language: 'fr',
      forced: true,
      provider: 'opensubtitlescom',
      providerSubtitleId: 'os-1',
      path: '/movies/Dune/Dune.fr.forced.srt',
      syncScore: 42,
      syncOffsetMs: 1250,
      syncDriftPpm: 42700,
      syncCheckedAt: '2026-10-25T10:00:00.000Z',
      syncMethod: 'builtin',
    }),
  );
  const file = (sub: SubtitleState): MediaFileSubtitles => ({ ...movieFile, subtitles: [sub, movieFile.subtitles[1]!] });

  async function openTab() {
    renderAt('/library/movie/1');
    fireEvent.click(await screen.findByRole('tab', { name: 'Subtitles' }));
    return screen.findByRole('table', { name: 'Subtitle languages for Dune.mkv' });
  }

  it('shows the score with a tone and the details in a tooltip', async () => {
    mockApi({ ...base, 'GET /movie/1': movie, 'GET /subtitle/file': [file(checked)] });
    await openTab();
    const badge = await screen.findByLabelText('Sync score 42 for French (forced)');
    expect(badge.textContent).toBe('42');
    expect(badge.getAttribute('data-tone')).toBe('danger');
    fireEvent.focus(badge);
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('Out of sync')).toBeTruthy();
    expect(within(tip).getByText('+1.25 s')).toBeTruthy();
    expect(within(tip).getByText('+42700 ppm')).toBeTruthy();
    expect(within(tip).getByText('builtin')).toBeTruthy();
  });

  it('shows a dash for never-checked subtitles and a muted ? for unmeasurable ones', async () => {
    const unmeasured = { ...checked, syncScore: null, syncOffsetMs: null, syncDriftPpm: null };
    mockApi({ ...base, 'GET /movie/1': movie, 'GET /subtitle/file': [file(unmeasured)] });
    await openTab();
    const badge = await screen.findByLabelText('Sync not measurable for French (forced)');
    expect(badge.textContent).toBe('?');
    expect(badge.getAttribute('data-tone')).toBe('muted');
    // The embedded track was never checked: no badge.
    expect(screen.getAllByTestId('sync-badge')).toHaveLength(1);
  });

  it('checks sync of a row and updates the badge from the refetched files', async () => {
    let current = file(SubtitleState.parse(makeSubtitle({ id: 11, language: 'fr', forced: true, provider: 'opensubtitlescom', providerSubtitleId: 'os-1' })));
    const result = SubtitleSyncCheckResult.parse({
      ok: true,
      message: 'Checked',
      check: { method: 'builtin', reliable: true, syncScore: 91, offsetMs: -80, driftPpm: 0, meanErrorMs: 60, confidence: 0.8, matched: 120, message: 'Good match' },
      actions: [],
      subtitle: { ...current.subtitles[0]!, syncScore: 91, syncOffsetMs: -80, syncDriftPpm: 0, syncCheckedAt: '2026-10-26T00:00:00.000Z', syncMethod: 'builtin' },
    });
    const calls = mockApi({
      ...base,
      'GET /movie/1': movie,
      'GET /subtitle/file': () => [current],
      'POST /subtitle/11/synccheck': () => {
        current = { ...current, subtitles: [result.subtitle!, current.subtitles[1]!] };
        return result;
      },
    });
    await openTab();
    expect(screen.queryByTestId('sync-badge')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Check sync of French (forced) subtitle' }));
    await waitFor(() => expect(calls.some((c: Call) => c.method === 'POST' && c.path === '/subtitle/11/synccheck')).toBe(true));
    const badge = await screen.findByLabelText('Sync score 91 for French (forced)');
    expect(badge.getAttribute('data-tone')).toBe('accent');
    expect(await screen.findByText('Sync score 91 (offset -80 ms)')).toBeTruthy();
  });

  it('offers Check sync only for external subtitles', async () => {
    mockApi({ ...base, 'GET /movie/1': movie, 'GET /subtitle/file': [movieFile] });
    await openTab();
    expect(await screen.findByRole('button', { name: 'Check sync of French (forced) subtitle' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check sync of English (HI) subtitle' })).toBeNull();
  });
});

describe('sync columns in subtitle history', () => {
  const record = SubtitleHistoryRecord.parse({
    id: 1,
    action: 'downloaded',
    description: 'English subtitle downloaded',
    language: 'en',
    forced: false,
    hi: false,
    provider: 'podnapisi',
    providerSubtitleId: 'p1',
    score: 300,
    scoreOutOf: 360,
    mediaType: 'series',
    seriesId: 3,
    movieId: null,
    episodeIds: [30],
    mediaFileId: 8,
    title: 'The Expanse S01E02',
    subtitlePath: '/tv/x.en.srt',
    videoPath: '/tv/x.mkv',
    matched: [],
    notMatched: [],
    upgradedFromId: null,
    syncScore: 64,
    syncOffsetMs: 320,
    syncDriftPpm: -12,
    date: '2026-10-20T00:00:00.000Z',
  });
  const page = (records: SubtitleHistoryRecord[]) => ({ page: 1, pageSize: 25, totalRecords: records.length, records });

  it('shows the sync score badge and offset / drift per record', async () => {
    const unchecked = { ...record, id: 2, syncScore: undefined, syncOffsetMs: undefined, syncDriftPpm: undefined };
    mockApi({ ...base, 'GET /subtitle/history': page([record, unchecked]) });
    renderAt('/subtitles/history');
    const badge = await screen.findByLabelText('Sync score 64 for The Expanse S01E02');
    expect(badge.getAttribute('data-tone')).toBe('warn');
    expect(screen.getByRole('columnheader', { name: 'Sync' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Offset · drift' })).toBeTruthy();
    expect(screen.getByText('+320 ms · -12 ppm')).toBeTruthy();
    expect(screen.getAllByTestId('sync-badge')).toHaveLength(1);
  });
});
