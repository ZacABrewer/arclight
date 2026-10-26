import { describe, expect, it } from 'vitest';
import { TranscodeRule, TranscodeRuleInput } from '@arclight/shared';
import { ACTION_OPTIONS, newRuleDraft, parseLanguages, toRuleBody, toRuleDraft, visibleOptions, whenSummary } from './transcode-model.js';

const rule = TranscodeRule.parse({
  id: 3,
  name: '4K HEVC to H.264',
  enabled: true,
  mediaType: 'movie',
  scope: { kind: 'tags', tagIds: [4] },
  when: { videoCodec: 'hevc', resolutionAbove: 1080, hdr: true },
  action: 'transcode',
  options: { container: 'mp4', videoCodec: 'h264', crf: 20, preset: 'slow', audio: 'aac', channels: 2, keepLanguages: ['eng'], dropSubtitles: false, hwaccel: 'nvenc' },
  keepOriginal: true,
  runAfterImport: false,
  schedule: { start: '01:00', end: '06:00' },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

describe('transcode rule model', () => {
  it('maps each action to the options it reads', () => {
    expect(ACTION_OPTIONS.remux).toEqual(['container', 'keepLanguages', 'dropSubtitles']);
    expect(visibleOptions('transcode', 'copy', 'copy')).toEqual(['container', 'videoCodec', 'audio', 'keepLanguages', 'dropSubtitles']);
    expect(visibleOptions('transcode', 'hevc', 'aac')).toEqual(['container', 'videoCodec', 'crf', 'preset', 'hwaccel', 'audio', 'channels', 'keepLanguages', 'dropSubtitles']);
    expect(visibleOptions('addAudioTrack', 'copy', 'aac')).toContain('channels');
    expect(visibleOptions('stripTracks', 'hevc', 'aac')).not.toContain('hwaccel');
  });

  it('round-trips a saved rule through the draft into a valid body', () => {
    const result = toRuleBody(toRuleDraft(rule));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      name: '4K HEVC to H.264',
      mediaType: 'movie',
      scope: { kind: 'tags', tagIds: [4] },
      when: { videoCodec: 'hevc', resolutionAbove: 1080, hdr: true },
      options: { container: 'mp4', videoCodec: 'h264', crf: 20, preset: 'slow', audio: 'aac', channels: 2, keepLanguages: ['eng'], hwaccel: 'nvenc' },
      keepOriginal: true,
      schedule: { start: '01:00', end: '06:00' },
    });
    expect(TranscodeRuleInput.safeParse(result.body).success).toBe(true);
  });

  it('sends only the options a remux uses and an empty when for "every file"', () => {
    const d = { ...newRuleDraft(), name: 'MP4 to MKV', action: 'remux' as const, videoCodec: 'hevc' as const, crf: '18', hwaccel: 'qsv' as const, keepLanguages: 'ENG, jpn' };
    const result = toRuleBody(d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.when).toEqual({});
    expect(result.body.options).toEqual({ container: 'mkv', keepLanguages: ['eng', 'jpn'], dropSubtitles: false });
    expect(result.body.schedule).toBeNull();
  });

  it('refuses a missing name, AV1 on VideoToolbox and an invalid CRF', () => {
    expect(toRuleBody(newRuleDraft())).toEqual({ ok: false, error: 'Name is required' });
    const av1 = toRuleBody({ ...newRuleDraft(), name: 'x', action: 'transcode', videoCodec: 'av1', hwaccel: 'videotoolbox' });
    expect(av1.ok).toBe(false);
    const crf = toRuleBody({ ...newRuleDraft(), name: 'x', action: 'transcode', videoCodec: 'hevc', crf: '99' });
    expect(crf.ok).toBe(false);
    if (!crf.ok) expect(crf.error).toContain('options.crf');
  });

  it('summarises conditions and parses language lists', () => {
    expect(whenSummary({})).toBe('Every file');
    expect(whenSummary({ container: 'mkv', videoCodec: 'hevc', hdr: false, sizeAboveGb: 10 })).toBe('mkv · hevc · SDR · >10 GiB');
    expect(parseLanguages(' eng,  JPN fre ')).toEqual(['eng', 'jpn', 'fre']);
  });
});
