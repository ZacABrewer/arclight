import { describe, expect, it } from 'vitest';
import type { MediaInfo } from '@arclight/shared';
import { chipAudio, chipDynamicRange, chipLanguages, chipResolution, mediaChipsOf, tmdbScoreOf } from './media-chips.js';

// Media chips (redesign spec §3.1): resolution buckets (width counts for scope), dynamic range,
// Atmos or the default track's layout, languages, size, TMDB score and the rating.

const info = (over: Partial<MediaInfo>): MediaInfo => ({ container: 'matroska', videoFormat: 'hevc', width: 1920, height: 1080, audioStreams: [], subtitleStreams: [], ...over }) as MediaInfo;

describe('media chips', () => {
  it('4K Dolby Vision with Atmos, three languages', () => {
    const chips = mediaChipsOf({
      file: {
        sizeBytes: 58_000_000_000,
        mediaInfo: info({
          width: 3840,
          height: 2160,
          videoDynamicRangeType: 'DV HDR10',
          audioStreams: [
            { codec: 'truehd', profile: 'TrueHD + Dolby Atmos', channels: 8, language: 'eng', default: true },
            { codec: 'ac3', channels: 6, language: 'ger', default: false },
            { codec: 'ac3', channels: 6, language: 'eng', default: false },
            { codec: 'aac', channels: 2, language: 'und', default: false },
            { codec: 'aac', channels: 2, language: 'FRE', default: false },
          ],
        } as Partial<MediaInfo>),
      },
      ratings: { tmdb: { value: 7.84, votes: 1234 } },
      certification: 'PG-13',
    });
    expect(chips).toEqual({ resolution: '4K', dynamicRange: 'DV', audio: 'Atmos', audioLanguages: ['eng', 'ger', 'fre'], sizeBytes: 58_000_000_000, tmdbScore: 7.8, certification: 'PG-13' });
  });

  it('1080p HDR10 5.1 (the default track decides the layout)', () => {
    const chips = mediaChipsOf({
      file: {
        sizeBytes: 9_000_000_000,
        mediaInfo: info({
          videoDynamicRangeType: 'HDR10',
          audioStreams: [
            { codec: 'aac', channels: 2, language: 'eng', default: false },
            { codec: 'eac3', channels: 6, language: 'eng', default: true },
          ],
        } as Partial<MediaInfo>),
      },
      ratings: { tmdb: { value: 6.5, votes: 50 } },
      certification: null,
    });
    expect(chips).toMatchObject({ resolution: '1080p', dynamicRange: 'HDR10', audio: '5.1', audioLanguages: ['eng'], tmdbScore: 6.5, certification: null });
  });

  it('720p SDR stereo', () => {
    const chips = mediaChipsOf({
      file: { sizeBytes: 700_000_000, mediaInfo: info({ width: 1280, height: 720, videoDynamicRangeType: 'SDR', audioStreams: [{ codec: 'aac', channels: 2, language: null, default: true }] } as Partial<MediaInfo>) },
      ratings: {},
      certification: 'TV-14',
    });
    expect(chips).toEqual({ resolution: '720p', dynamicRange: null, audio: 'Stereo', audioLanguages: [], sizeBytes: 700_000_000, tmdbScore: null, certification: 'TV-14' });
  });

  it('resolution buckets: 1440p is 1080p, width counts for scope and cropped files, small is SD', () => {
    expect(chipResolution(2560, 1440)).toBe('1080p');
    expect(chipResolution(3840, 1600)).toBe('4K');
    expect(chipResolution(1920, 800)).toBe('1080p');
    expect(chipResolution(1280, 536)).toBe('720p');
    expect(chipResolution(720, 480)).toBe('SD');
    expect(chipResolution(null, null)).toBeNull();
  });

  it('dynamic range, audio and languages edge cases', () => {
    expect(chipDynamicRange(info({ videoDynamicRangeType: 'HDR10Plus' } as Partial<MediaInfo>))).toBe('HDR10+');
    expect(chipDynamicRange(info({ videoDynamicRangeType: 'HLG' } as Partial<MediaInfo>))).toBe('HLG');
    expect(chipAudio(info({ audioStreams: [{ codec: 'eac3', profile: 'Dolby Digital Plus + Dolby Atmos', channels: 6, default: false }] } as Partial<MediaInfo>))).toBe('Atmos');
    expect(chipAudio(info({ audioStreams: [{ codec: 'dts', channels: 8, default: true }] } as Partial<MediaInfo>))).toBe('7.1');
    expect(chipAudio(info({ audioStreams: [{ codec: 'mp3', channels: 1, default: true }] } as Partial<MediaInfo>))).toBe('Mono');
    expect(chipAudio(info({ audioStreams: [] }))).toBeNull();
    expect(chipLanguages(null)).toEqual([]);
  });

  it('TMDB score: one decimal; none when unrated or under 10 votes', () => {
    expect(tmdbScoreOf({ tmdb: { value: 8.25, votes: 10 } })).toBe(8.3);
    expect(tmdbScoreOf({ tmdb: { value: 8, votes: 9 } })).toBeNull();
    expect(tmdbScoreOf({ tmdb: { value: 0, votes: 500 } })).toBeNull();
    expect(tmdbScoreOf({ tmdb: { value: 7.1 } })).toBe(7.1);
    expect(tmdbScoreOf(null)).toBeNull();
  });

  it('no file: score and rating only', () => {
    expect(mediaChipsOf({ file: null, ratings: { tmdb: { value: 7, votes: 99 } }, certification: 'R' })).toEqual({
      resolution: null,
      dynamicRange: null,
      audio: null,
      audioLanguages: [],
      sizeBytes: null,
      tmdbScore: 7,
      certification: 'R',
    });
  });
});
