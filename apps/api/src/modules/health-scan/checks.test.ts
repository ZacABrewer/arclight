import { describe, expect, it } from 'vitest';
import {
  bookPartProblems,
  checkFile,
  decodeArgs,
  decodeSlices,
  describe as describeFinding,
  insideWindow,
  isSampleName,
  languageProblem,
  languageRequirement,
  scheduleCron,
  trackGaps,
  truncation,
  withLowPriority,
  type FileFacts,
} from './checks.js';

const ok = { kind: 'ok' as const, sizeBytes: 1000, mtimeMs: 1 };
const probeOk = (over: Partial<{ durationSeconds: number | null; hasVideo: boolean; audioStreamCount: number; audioLanguages: string[] }> = {}) => ({
  ok: true as const,
  info: { durationSeconds: 2700, hasVideo: true, audioStreamCount: 1, audioLanguages: ['eng'], ...over },
});
const facts = (over: Partial<FileFacts> = {}): FileFacts => ({ kind: 'video', path: '/tv/Show/S01E01.mkv', stat: ok, truncatedPercent: 75, ...over });
const types = (f: FileFacts) => checkFile(f).map((d) => d.type);

describe('checkFile', () => {
  it('finds nothing wrong with a healthy file', () => {
    expect(checkFile(facts({ probe: probeOk(), decode: { exitCode: 0, errors: [] }, expectedSeconds: 2640 }))).toEqual([]);
  });

  it('missing, unreadable and empty files stop further checks', () => {
    expect(checkFile(facts({ stat: { kind: 'missing' }, probe: probeOk() }))).toMatchObject([{ type: 'missing', severity: 'error' }]);
    expect(checkFile(facts({ stat: { kind: 'unreadable', message: 'EACCES' } }))).toMatchObject([{ type: 'unreadable', severity: 'error', data: { message: 'EACCES' } }]);
    expect(checkFile(facts({ stat: { kind: 'ok', sizeBytes: 0, mtimeMs: 1 } }))).toMatchObject([{ type: 'empty', severity: 'error' }]);
  });

  it('a container ffprobe cannot read is unparseable', () => {
    const [d] = checkFile(facts({ probe: { ok: false, message: 'Invalid data found when processing input' } }));
    expect(d).toMatchObject({ type: 'unparseable', severity: 'error' });
    expect(d!.details).toContain('Invalid data found');
  });

  it('reports missing streams (video only for video files)', () => {
    expect(types(facts({ probe: probeOk({ hasVideo: false, audioStreamCount: 0 }) }))).toEqual(['noVideo', 'noAudio']);
    expect(types(facts({ kind: 'track', trackNumber: 1, probe: probeOk({ hasVideo: false }) }))).toEqual([]);
    expect(types(facts({ kind: 'track', trackNumber: 1, probe: probeOk({ hasVideo: false, audioStreamCount: 0 }) }))).toEqual(['noAudio']);
  });

  it('flags truncated files, and very short ones (or named so) as samples', () => {
    expect(checkFile(facts({ probe: probeOk({ durationSeconds: 1200 }), expectedSeconds: 2700 }))).toMatchObject([
      { type: 'truncated', severity: 'warning', data: { actualSeconds: 1200, expectedSeconds: 2700 } },
    ]);
    expect(types(facts({ probe: probeOk({ durationSeconds: 60 }), expectedSeconds: 2700 }))).toEqual(['sample']);
    expect(types(facts({ path: '/m/Film/film-sample.mkv', probe: probeOk({ durationSeconds: 60 }), expectedSeconds: 7200 }))).toEqual(['sample']);
    expect(types(facts({ probe: probeOk({ durationSeconds: 2500 }), expectedSeconds: 2700 }))).toEqual([]);
    expect(types(facts({ probe: probeOk({ durationSeconds: 1200 }), expectedSeconds: null }))).toEqual([]);
  });

  it('decode errors are a warning, an error when many or when ffmpeg failed', () => {
    const few = checkFile(facts({ probe: probeOk(), decode: { exitCode: 0, errors: ['[h264] error while decoding MB 1 2'] }, decodeMode: 'quick' }));
    expect(few).toMatchObject([{ type: 'decodeErrors', severity: 'warning', data: { mode: 'quick', errorCount: 1 } }]);
    const many = checkFile(facts({ probe: probeOk(), decode: { exitCode: 0, errors: Array.from({ length: 12 }, (_, i) => `err ${i}`) }, decodeMode: 'deep' }));
    expect(many[0]).toMatchObject({ severity: 'error', data: { errorCount: 12, mode: 'deep' } });
    expect(many[0]!.data.errors).toHaveLength(5);
    expect(checkFile(facts({ probe: probeOk(), decode: { exitCode: 1, errors: [] } }))[0]).toMatchObject({ type: 'decodeErrors', severity: 'error' });
  });

  it('checks audio languages against the requirement', () => {
    const lang = { wanted: ['en'], required: [] };
    expect(types(facts({ probe: probeOk({ audioLanguages: ['jpn'] }), language: lang }))).toEqual(['wrongLanguage']);
    expect(types(facts({ probe: probeOk({ audioLanguages: ['jpn', 'eng'] }), language: lang }))).toEqual([]);
    // Untagged audio says nothing.
    expect(types(facts({ probe: probeOk({ audioLanguages: [] }), language: lang }))).toEqual([]);
  });

  it('music: a missing track number is info', () => {
    expect(checkFile(facts({ kind: 'track', trackNumber: null, probe: probeOk({ hasVideo: false }) }))).toMatchObject([{ type: 'trackNumberMissing', severity: 'info' }]);
  });

  it('works without ffprobe/ffmpeg (stat checks only)', () => {
    expect(checkFile(facts({ probe: null, decode: null }))).toEqual([]);
  });
});

describe('truncation', () => {
  it('needs both durations and a real shortfall; tracks also 10 s', () => {
    expect(truncation('video', 100, 200, 75)).toBe(true);
    expect(truncation('video', 160, 200, 75)).toBe(false);
    expect(truncation('video', null, 200, 75)).toBe(false);
    expect(truncation('track', 20, 25, 90)).toBe(false);
    expect(truncation('track', 100, 240, 75)).toBe(true);
  });
});

describe('languages', () => {
  it('resolves original, accepts anything for empty or unknown profiles, adds required languages', () => {
    expect(languageRequirement(['original'], 'ja')).toEqual({ wanted: ['ja'], required: [] });
    expect(languageRequirement([], 'ja')).toBeNull();
    expect(languageRequirement(['unknown', 'en'], 'ja')).toBeNull();
    expect(languageRequirement([], 'en', ['es'])).toEqual({ wanted: [], required: ['es'] });
    expect(languageRequirement(['English', 'fr'], null)).toEqual({ wanted: ['en', 'fr'], required: [] });
  });

  it('reports what is missing', () => {
    expect(languageProblem(['eng'], { wanted: ['en'], required: ['es'] })).toEqual({ have: ['en'], wanted: ['en'], missing: ['es'] });
    expect(languageProblem(['ger'], { wanted: ['en', 'fr'], required: [] })).toEqual({ have: ['de'], wanted: ['en', 'fr'] });
    expect(languageProblem(['fre'], { wanted: ['en', 'fr'], required: [] })).toBeNull();
  });
});

describe('album and book structure', () => {
  it('finds track number gaps per disc', () => {
    expect(trackGaps([1, 2, 4, 6].map((n) => ({ discNumber: 1, trackNumber: n })))).toEqual([{ disc: 1, missing: [3, 5] }]);
    expect(
      trackGaps([
        { discNumber: 1, trackNumber: 1 },
        { discNumber: 1, trackNumber: 2 },
        { discNumber: 2, trackNumber: 1 },
        { discNumber: 2, trackNumber: 3 },
        { discNumber: null, trackNumber: null },
      ]),
    ).toEqual([{ disc: 2, missing: [2] }]);
    expect(trackGaps([{ discNumber: 1, trackNumber: 5 }])).toEqual([]);
  });

  it('finds missing, duplicated and out-of-order book parts', () => {
    expect(bookPartProblems([{ path: '/b/Part 1.mp3', partNumber: 1 }, { path: '/b/Part 2.mp3', partNumber: 2 }])).toBeNull();
    expect(bookPartProblems([{ path: '/b/Part 1.mp3', partNumber: 1 }, { path: '/b/Part 3.mp3', partNumber: 3 }])).toEqual({ missingNumbers: [2], duplicateNumbers: [], outOfOrder: false });
    expect(bookPartProblems([{ path: '/b/a.mp3', partNumber: 2 }, { path: '/b/b.mp3', partNumber: 1 }])).toMatchObject({ outOfOrder: true });
    expect(bookPartProblems([{ path: '/b/Part 2.mp3', partNumber: 1 }, { path: '/b/Part 10.mp3', partNumber: 2 }])).toBeNull();
    expect(bookPartProblems([{ path: '/b/1.mp3', partNumber: 1 }, { path: '/b/1b.mp3', partNumber: 1 }])).toMatchObject({ duplicateNumbers: [1] });
    // Nothing to infer from.
    expect(bookPartProblems([{ path: '/b/a.mp3', partNumber: null }, { path: '/b/b.mp3', partNumber: null }])).toBeNull();
    expect(bookPartProblems([{ path: '/b/a.m4b', partNumber: 3 }])).toBeNull();
  });
});

describe('decode plan', () => {
  it('quick mode decodes start, middle and end; deep mode everything', () => {
    expect(decodeSlices('quick', 3600)).toEqual([
      { start: 0, length: 10 },
      { start: 1795, length: 10 },
      { start: 3589, length: 10 },
    ]);
    expect(decodeSlices('quick', 30)).toEqual([{ start: 0, length: null }]);
    expect(decodeSlices('quick', null)).toEqual([{ start: 0, length: 30 }]);
    expect(decodeSlices('deep', 3600)).toEqual([{ start: 0, length: null }]);
  });

  it('builds the ffmpeg arguments', () => {
    expect(decodeArgs('/m/x.mkv', { start: 1795, length: 10 }, 'video')).toEqual([
      '-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-ss', '1795', '-t', '10', '-i', '/m/x.mkv', '-map', '0:v:0?', '-map', '0:a?', '-f', 'null', '-',
    ]);
    expect(decodeArgs('/a/t.flac', { start: 0, length: null }, 'track')).toEqual(['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-i', '/a/t.flac', '-map', '0:a?', '-f', 'null', '-']);
  });

  it('wraps commands in nice / ionice when they exist', () => {
    expect(withLowPriority('/usr/bin/ffmpeg', ['-i', 'x'], { nice: '/usr/bin/nice', ionice: '/usr/bin/ionice' })).toEqual({
      file: '/usr/bin/nice',
      args: ['-n', '19', '/usr/bin/ionice', '-c', '3', '/usr/bin/ffmpeg', '-i', 'x'],
    });
    expect(withLowPriority('ffmpeg', ['-i', 'x'], { nice: '/bin/nice', ionice: null })).toEqual({ file: '/bin/nice', args: ['-n', '19', 'ffmpeg', '-i', 'x'] });
    expect(withLowPriority('ffmpeg', ['-i', 'x'], { nice: null, ionice: null })).toEqual({ file: 'ffmpeg', args: ['-i', 'x'] });
  });
});

describe('schedule and window', () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 4, h, m);
  it('honours a daily window, including one across midnight', () => {
    expect(insideWindow(at(12), { enabled: false, start: '01:00', end: '06:00' })).toBe(true);
    expect(insideWindow(at(3), { enabled: true, start: '01:00', end: '06:00' })).toBe(true);
    expect(insideWindow(at(6), { enabled: true, start: '01:00', end: '06:00' })).toBe(false);
    expect(insideWindow(at(23, 30), { enabled: true, start: '22:00', end: '05:00' })).toBe(true);
    expect(insideWindow(at(12), { enabled: true, start: '22:00', end: '05:00' })).toBe(false);
  });

  it('derives the cron from the schedule and window start', () => {
    const window = { enabled: false, start: '01:30' };
    expect(scheduleCron({ schedule: 'weekly', window })).toBe('0 3 * * 0');
    expect(scheduleCron({ schedule: 'daily', window: { ...window, enabled: true } })).toBe('30 1 * * *');
    expect(scheduleCron({ schedule: 'off', window })).toBeNull();
  });
});

describe('misc', () => {
  it('recognises sample names and writes plain-language details', () => {
    expect(isSampleName('/m/Film (2020)/Sample/film-sample.mkv')).toBe(true);
    expect(isSampleName('/m/Samples of Life (2020)/film.mkv')).toBe(false);
    expect(describeFinding('truncated', { actualSeconds: 1200, expectedSeconds: 2700 })).toBe(
      'The file plays for 20:00, but the runtime should be about 45:00. It is probably cut short.',
    );
    expect(describeFinding('bookParts', { missingNumbers: [2], outOfOrder: true })).toContain('part 2 missing');
  });
});
