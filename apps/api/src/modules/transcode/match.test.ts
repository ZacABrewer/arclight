import { describe, expect, it } from 'vitest';
import type { MediaInfo, TranscodeWhen } from '@arclight/shared';
import { inWindow, ruleMatches, whenMatches, type MatchableRule } from './match.js';
import { FfmpegProgressParser, parseProgressOutput, durationMsOf } from './progress.js';
import { H264_INFO, HEVC_INFO } from './test-support.js';

const at = (h: number, m = 0) => new Date(2026, 9, 26, h, m, 0);

describe('inWindow', () => {
  it('null and start == end are always open', () => {
    expect(inWindow(null, at(3))).toBe(true);
    expect(inWindow({ start: '05:00', end: '05:00' }, at(17))).toBe(true);
  });

  it.each([
    [0, 59, false],
    [1, 0, true],
    [3, 30, true],
    [5, 59, true],
    [6, 0, false],
    [23, 0, false],
  ])('01:00-06:00 at %i:%i -> %s', (h, m, open) => {
    expect(inWindow({ start: '01:00', end: '06:00' }, at(h, m))).toBe(open);
  });

  it.each([
    [21, 59, false],
    [22, 0, true],
    [23, 59, true],
    [0, 0, true],
    [5, 59, true],
    [6, 0, false],
    [12, 0, false],
  ])('22:00-06:00 (crosses midnight) at %i:%i -> %s', (h, m, open) => {
    expect(inWindow({ start: '22:00', end: '06:00' }, at(h, m))).toBe(open);
  });
});

describe('rule matching', () => {
  const file = (info: MediaInfo | null, sizeBytes = 5 * 1024 ** 3, mediaType: 'series' | 'movie' = 'movie') => ({ mediaType, sizeBytes, mediaInfo: info });
  const rule = (when: TranscodeWhen = {}, extra: Partial<MatchableRule> = {}): MatchableRule => ({ mediaType: 'all', scope: { kind: 'all' }, when, ...extra });
  const parent = { tags: [3], qualityProfileId: 7 };

  it('media type and scope', () => {
    expect(ruleMatches(rule({}, { mediaType: 'series' }), file(HEVC_INFO), parent)).toBe(false);
    expect(ruleMatches(rule({}, { mediaType: 'movie' }), file(HEVC_INFO), parent)).toBe(true);
    expect(ruleMatches(rule({}, { scope: { kind: 'tags', tagIds: [1, 3] } }), file(HEVC_INFO), parent)).toBe(true);
    expect(ruleMatches(rule({}, { scope: { kind: 'tags', tagIds: [4] } }), file(HEVC_INFO), parent)).toBe(false);
    expect(ruleMatches(rule({}, { scope: { kind: 'profiles', qualityProfileIds: [7] } }), file(HEVC_INFO), parent)).toBe(true);
    expect(ruleMatches(rule({}, { scope: { kind: 'profiles', qualityProfileIds: [1] } }), file(HEVC_INFO), parent)).toBe(false);
    expect(ruleMatches(rule({}, { scope: { kind: 'tags', tagIds: [3] } }), file(HEVC_INFO), null)).toBe(false);
  });

  it.each<[TranscodeWhen, MediaInfo, boolean]>([
    [{ videoCodec: 'x265' }, HEVC_INFO, true],
    [{ videoCodec: 'h265' }, HEVC_INFO, true],
    [{ videoCodec: 'avc' }, HEVC_INFO, false],
    [{ videoCodec: 'avc' }, H264_INFO, true],
    [{ audioCodec: 'ac3' }, HEVC_INFO, true], // second track
    [{ audioCodec: 'eac3' }, HEVC_INFO, false],
    [{ container: 'mkv' }, HEVC_INFO, true],
    [{ container: 'mp4' }, HEVC_INFO, false],
    [{ hdr: true }, HEVC_INFO, true],
    [{ hdr: true }, H264_INFO, false],
    [{ hdr: false }, H264_INFO, true],
    [{ resolutionAbove: 1080 }, HEVC_INFO, true],
    [{ resolutionAbove: 1080 }, H264_INFO, false],
    [{ bitrateAboveKbps: 20_000 }, HEVC_INFO, true],
    [{ bitrateAboveKbps: 20_000 }, H264_INFO, false],
    [{ hdr: true, resolutionAbove: 1080, videoCodec: 'hevc' }, HEVC_INFO, true],
    [{ hdr: true, resolutionAbove: 2160 }, HEVC_INFO, false],
  ])('when %j', (when, info, expected) => {
    expect(whenMatches(when, file(info))).toBe(expected);
  });

  it('size conditions use GiB and need no media info; other conditions do', () => {
    expect(whenMatches({ sizeAboveGb: 4 }, file(null))).toBe(true);
    expect(whenMatches({ sizeAboveGb: 6 }, file(null))).toBe(false);
    expect(whenMatches({}, file(null))).toBe(true);
    expect(whenMatches({ videoCodec: 'hevc' }, file(null))).toBe(false);
  });

  it('resolution falls back to the WxH string', () => {
    expect(whenMatches({ resolutionAbove: 720 }, file({ resolution: '1280x800' }))).toBe(true);
  });
});

describe('progress parsing', () => {
  const block = (lines: string[], end = 'continue') => `${lines.join('\n')}\nprogress=${end}\n`;

  it('reads out_time_us against the duration', () => {
    expect(parseProgressOutput(block(['frame=10', 'out_time_us=25000000', 'speed=2.1x']), 100_000)).toEqual({ outTimeMs: 25_000, percent: 25, done: false });
  });

  it('out_time_ms is microseconds too; out_time is the fallback', () => {
    expect(parseProgressOutput(block(['out_time_ms=50000000']), 100_000)?.percent).toBe(50);
    expect(parseProgressOutput(block(['out_time_us=N/A', 'out_time=00:01:15.500000']), 100_000)?.outTimeMs).toBe(75_500);
    expect(parseProgressOutput(block(['out_time_us=N/A', 'out_time=N/A']), 100_000)).toEqual({ outTimeMs: null, percent: null, done: false });
  });

  it('end is 100, running never reports 100, unknown duration gives null', () => {
    expect(parseProgressOutput(block(['out_time_us=1'], 'end'), 100_000)?.percent).toBe(100);
    expect(parseProgressOutput(block(['out_time_us=200000000']), 100_000)?.percent).toBe(99.9);
    expect(parseProgressOutput(block(['out_time_us=1000000']), null)?.percent).toBeNull();
  });

  it('handles blocks split across chunks and CRLF', () => {
    const parser = new FfmpegProgressParser(10_000);
    expect(parser.push('frame=1\r\nout_time_u')).toEqual([]);
    expect(parser.push('s=2500000\r\nprogress=continue\r\nout_time_us=5000000\nprog')).toEqual([{ outTimeMs: 2500, percent: 25, done: false }]);
    expect(parser.push('ress=end\n')).toEqual([{ outTimeMs: 5000, percent: 100, done: true }]);
  });

  it('duration from media info', () => {
    expect(durationMsOf({ durationMs: 1234 })).toBe(1234);
    expect(durationMsOf({ runtimeSeconds: 60 })).toBe(60_000);
    expect(durationMsOf(null)).toBeNull();
  });
});
